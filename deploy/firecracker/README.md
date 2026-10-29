# Dedicated KVM node: initial lifecycle adapter

This is the opt-in host power/capacity layer for the [personal runtime proposal](../../docs/personal-assistant-runtime-architecture.md). The local development guest has passed real KVM, jailer/systemd, persistence, Zendriver, and default-deny egress acceptance. Live owner-scoped PostgreSQL routing and production isolation remain rollout gates. K8s continues hosting the control plane; this agent runs on the KVM host.

## Operator prerequisites

- Linux/KVM, systemd/cgroup v2, `jq`, Node 22+, and independently verified matching musl Firecracker/jailer binaries at `/usr/local/bin/firecracker` and `/usr/local/bin/jailer`. Follow the [official jailer guidance](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md).
- A root-owned filesystem at `/srv/trinity-node`, mode `0700`, with an explicit storage policy. Production requires `NODE_STORAGE_ENCRYPTION=host-managed` or `provider-managed`; both are operator attestations, not automatic encryption detection. `none` is accepted only with `NODE_DEPLOYMENT_MODE=development`.
- Approved `images/vmlinux` and read-only `images/rootfs.ext4`. The guest image must support the supplied virtio disks/network, booting a read-only root and mounting its private data disk. No image is downloaded or manufactured automatically.
- A per-environment `volumes/<environment-id>/data.ext4` and root-owned `runtime.json`, containing unique non-root numeric `uid` and `gid` (both at least 100000). Reserve those IDs per environment. Backing files and images must reside on the same filesystem because the launcher uses hard links. Production storage must be encrypted at the host or provider layer; explicit development mode may use unencrypted local storage and does not establish tenant isolation.
- An operator-provisioned `/run/netns/trinity-<environment-id>` containing `tap0`, isolated from other users. Development egress is optional and remains disabled until the host gateway is installed. The guest receives no proxy URL or credentials. The namespace's existence is a prerequisite, not proof that its firewall is correct. A namespace/TAP lost to a host reboot is reconstructed automatically on the next start by the installed egress helper; only the data disk and runtime identity must already exist.

The node ID, endpoint and admitted CPU/memory capacity must agree with the server's `FIRECRACKER_NODES`. Never point this inventory at a user-controlled endpoint. Remote management requires an operator-authenticated TLS/mTLS proxy; the Node Agent itself listens only on loopback. Keep CDP, Firecracker API sockets and guest RPC off the public network.

## Installation

On a supported KVM host, install the pinned Firecracker v1.17.0 and jailer binaries, `jq` if missing, the VM template unit, and the fixed launcher with:

```bash
sudo bash scripts/install-firecracker-host.sh
```

The installer checks `/dev/kvm`, downloads the official x86_64 or aarch64 release over HTTPS, verifies the pinned SHA-256, and copies only the two expected regular executables. It does not enable or start any VM. It also does not encrypt storage or create guest images, per-user disks, or network namespaces. Keep the unit/launcher, images, manifests and volume metadata inaccessible to user workloads.

The installed binaries are Firecracker v1.17.0, a supported upstream release as of this guide. Upgrade the pinned version and both architecture checksums together after reviewing upstream release notes. See the [official release](https://github.com/firecracker-microvm/firecracker/releases/tag/v1.17.0) and [release policy](https://github.com/firecracker-microvm/firecracker/blob/main/docs/RELEASE_POLICY.md).

The optional guest egress setup also requires the host's `iproute2`, `nftables`, `dnsmasq`, and systemd tools. The installer checks for these prerequisites and fails without installing packages if one is missing.

### Draining a node before release

Apply the latest database migration before deploying the server and Node Agent versions that support node maintenance. Host upgrades must drain the node through the control plane before running host installers. Configure the separate `FIRECRACKER_MAINTENANCE_TOKEN` on the server and in the release environment; it must be at least 32 URL-safe characters. The server must already list the node in `FIRECRACKER_NODES`. The positional node ID selects the node to drain; if `NODE_ID` is set on the release runner, it must match that ID. The release wrapper marks the node unavailable for new starts and guest RPCs, waits for admitted guest calls to finish, asks the Node Agent to stop every assigned environment, and requires both PostgreSQL and the local systemd/process checks to confirm that no VMM remains. It runs the supplied release command only after those checks. A failed drain or release leaves the node in maintenance; a successful command clears maintenance so new environments can be assigned. Stopped environments keep their data disks and wake as fresh generations later.

```bash
FIRECRACKER_MAINTENANCE_URL=https://server.example \
FIRECRACKER_MAINTENANCE_TOKEN="$FIRECRACKER_MAINTENANCE_TOKEN" \
  bash scripts/release-firecracker-node.sh host-1 -- \
  sudo bash scripts/install-firecracker-host-egress.sh
```

The wrapper runs on the Firecracker host. In a hosted release pipeline, provide the host command's required privilege non-interactively through the pipeline's existing service account. Do not call the installer directly when a node is in service; its active-VM check remains a final guard. If a release command fails after drain, fix or roll back the host and rerun the wrapper; do not manually clear maintenance while any VMM is active.

### Optional host-routed guest IPv4

The guest does not receive proxy settings. To give development guests IPv4 connectivity through the host, install the host bridge/NAT and DNS relay:

```bash
sudo bash scripts/install-firecracker-host-egress.sh
```

This creates `trinity-egress0` on `172.29.240.1/20`, enables host IPv4 forwarding, isolates guest bridge ports from each other, relays guest DNS through the host resolver, and NATs public IPv4 traffic through the host routing table. Guest IPv6 and private/reserved destinations are blocked. The installer refuses to run while a Trinity VM unit or Firecracker process is active; use the release wrapper above to drain the node first. It installs a fixed root-owned route helper and a restricted one-shot systemd unit for the helper's network capabilities, then clears any DNS start-limit failure and restarts the DNS relay so its updated socket restrictions take effect. DNS startup waits for dnsmasq to finish initialization before the release can succeed. If Node Agent was active, the installer restarts it after confirming the gateway services are active. On every authenticated environment start, Node Agent detects the active host gateway and starts the route unit for that PostgreSQL-assigned environment before launching its VMM, including for existing stopped environments. New provisioning continues to configure routes automatically. The helper is idempotent; if route setup fails, Node Agent refuses to start the VM. The installer uses `SANDBOX_PROXY_URL` for the whole guest when configured, otherwise direct host routing and the host resolver; it does not choose a proxy provider or change destination allow/deny lists. When Docker uses its iptables backend, gateway startup adds idempotent IPv4 rules in `DOCKER-USER` for traffic from `trinity-egress0` / `172.29.240.0/20` and established return traffic. It inserts them after existing operator rules and before the first unconditional `RETURN`, preserving earlier explicit denials. Trinity’s earlier nftables drops for private/reserved destinations, IPv6 and unsolicited inbound traffic remain authoritative. Docker’s `FORWARD DROP` policy and unrelated rules are preserved. The gateway starts after standard or Snap Docker services; an upgrade restarts the gateway so the updated helper actually runs. Other host firewall policies may still deny forwarding. See [Docker’s forwarding guidance](https://docs.docker.com/engine/network/firewall-iptables/#allow-forwarding-between-host-interfaces).

If a running, already configured gateway cannot forward guest traffic because Docker has `FORWARD DROP` and an empty `DOCKER-USER`, apply only the scoped forwarding repair from the reviewed checkout:

```bash
sudo bash deploy/firecracker/trinity-firecracker-egress-up docker-forwarding
```

This repair checks the existing bridge and both Trinity-owned nftables tables, then adds only the missing Docker rules. It leaves running VMs and the existing nftables rules in place; it does not install a host release. Afterward, validate guest DNS/TCP/HTTPS and the configured browser operation. Hosts requiring a proxy must configure `SANDBOX_PROXY_URL` and apply the normal installer below. For persistence across host boot or gateway upgrades, deploy the updated helper and service through the maintenance release wrapper; retain the installer’s active-VM guard.

#### Whole-guest egress with SANDBOX_PROXY_URL

Set the existing host HTTP proxy once in the deployment `.env`:

```dotenv
SANDBOX_PROXY_URL=http://127.0.0.1:20112
```

The whole guest uses that egress, including commands, browsers and DNS. There is no separate browser traffic configuration. When the setting is empty/unset, the gateway uses direct host routing and the host resolver. This does not change the host default route or proxy control-plane traffic. The proxy URL stays on the host; guest processes use their ordinary network interface. Virtual DNS preserves hostnames for HTTP proxies that route by domain: only the synthetic `198.19.0.0/16` pool is admitted to the guest-only tunnel. Other literal private/reserved destinations remain blocked. The supplied proxy controls final destination resolution and policy; this development path does not establish production isolation.

The normal gateway installer reads the repository `.env`; `--env-file /absolute/deployment.env` selects a different deployment file. It reads only `SANDBOX_PROXY_URL` and never evaluates shell expressions or copies other app secrets. Apply changes through the same maintenance release wrapper:

```bash
FIRECRACKER_MAINTENANCE_URL=https://server.example \
FIRECRACKER_MAINTENANCE_TOKEN="$FIRECRACKER_MAINTENANCE_TOKEN" \
  bash scripts/release-firecracker-node.sh host-1 -- \
  sudo bash scripts/install-firecracker-host-egress.sh
```

The adapter uses generic [tun2proxy v0.8.6](https://github.com/tun2proxy/tun2proxy/releases/tag/v0.8.6), downloaded from the official release with pinned architecture checksums. The adapter handles proxy-side hostname resolution itself; no separate DNS service is required. No Clash core, provider configuration, GeoIP file or additional proxy JSON is required. The tested guest path supports a credential-free `http://host:port` upstream. An HTTP proxy does not provide arbitrary UDP forwarding; unsupported traffic is not sent directly. Dependency paths may be supplied as `TUN2PROXY_BINARY` for a reviewed offline install.

The installer stages dependencies/configuration before changing services, installs persistent files under `/etc/trinity/sandbox-egress` and `/usr/local/libexec`, and enables `trinity-sandbox-egress.service`. It retires only the owned earlier `operator-guest-*` installation. It keeps the active-VM guard, the existing dnsmasq relay, FD-owned TUN validation and a guest-only policy table. Configured proxy failure blocks guest startup or egress rather than silently using direct routing. Removing `SANDBOX_PROXY_URL` on a subsequent release disables these services and restores direct routing; old installed settings never override the current deployment setting. No guest image rebuild is needed for this host-only change.

Fresh development provisioning configures the guest TAP route automatically. Existing stopped environments are configured automatically on their next authenticated wake when the host gateway is active, and a namespace/TAP lost to a host reboot is reconstructed automatically on the next start (see below). The helper can also be invoked directly for operator recovery:

```bash
sudo bash scripts/configure-firecracker-guest-egress.sh <environment-id>
```

After a host reboot, `/run/netns` and its TAP/veth devices can be absent while the existing data disk and `network.json` remain. Do not rerun the fresh provisioner or replace the user's volume. The next authenticated wake/start repairs this automatically: the VM launcher (host mount namespace) requires provisioned host storage, the existing data disk and valid runtime UID/GID, archives the old network metadata under the provisioning lock, recreates only the namespace/TAP, and then runs the idempotent egress helper — preserving the data disk, runtime identity and immutable images in every storage mode. Existing namespaces without their egress, active or unconfirmed VMMs, missing storage or data disks, and invalid runtime identity still fail closed. The sandboxed egress unit defers namespace reconstruction to the launcher (bind mounts do not propagate out of its isolated mount namespace).

For ambiguous failures that fail closed, an explicit repair remains available through the maintenance gate (for `development-unencrypted` environments):

```bash
FIRECRACKER_MAINTENANCE_URL=http://127.0.0.1:3000 \
  bash scripts/release-firecracker-node.sh local-kvm-01 -- \
  pkexec /usr/bin/bash "$PWD/scripts/recover-firecracker-development-network.sh" <environment-id>
```

Supply the existing maintenance token through the operator environment. The explicit repair requires the original protected volume/runtime/network metadata, confirms there is no active VMM or existing namespace/interface, archives the old network metadata, and recreates only the namespace/TAP through the installed egress helper. Failed or ambiguous repairs retain artifacts for inspection. After a successful explicit repair/resume, wake the environment for a fresh generation and separately verify guest RPC and browser frames.

Rebuild the development guest rootfs after changing its network configuration, preserve the per-environment writable data disk, and start a fresh generation. This is a development NAT path, not a production isolation guarantee or a domain allowlist. `SANDBOX_PROXY_URL` selects whole-guest egress on the host.

### Local storage setup

For this workstation's development smoke test, prepare a root-owned unencrypted directory without touching any physical disk:

```bash
sudo bash scripts/setup-firecracker-storage.sh --development-unencrypted
```

Unencrypted setup is explicit and must be paired with `NODE_DEPLOYMENT_MODE=development` and `NODE_STORAGE_ENCRYPTION=none`. To use host-managed LUKS on this local workstation, run:

```bash
sudo bash scripts/setup-firecracker-storage.sh --encrypted
```

This creates a 64 GiB LUKS2 container file under the sudo caller's `/home` directory and mounts its ext4 filesystem at `/srv/trinity-node`. It does not repartition or format physical disks. It prompts for a LUKS passphrase; never put that passphrase in a file or command argument. After reboot, rerun the command and enter the passphrase to unlock the volume. The script refuses to overwrite an existing non-LUKS path or format an unexpected filesystem. This local container recipe is not the production storage recommendation: production hosts should use verified provider-managed encryption or operator-managed encrypted block storage with documented recovery procedures. The mode is an operator attestation, not automatic encryption detection.

After preparing storage, provision approved guest kernel/rootfs images, a per-environment data volume and manifest, and a default-deny network namespace as described above. Storage setup alone does not make a guest image or start a VM.

### Disposable boot and vsock smoke check

After installing `debootstrap`, build a local-only probe image and run it as the ordinary KVM-group user:

```bash
sudo bash scripts/build-firecracker-smoke-guest.sh
bash scripts/run-firecracker-smoke-test.sh
```

The builder writes only to `~/.local/share/trinity/firecracker-smoke`, copies the current host kernel and its matching VSOCK modules, and creates a minimal Ubuntu rootfs with a dummy RPC responder. The runner starts Firecracker directly without the jailer, with no network interface and no user data disk; it calls the real `FirecrackerGuestRelay` and stops the VMM afterward. The marker prevents the test runner from accepting another image. This checks local KVM boot and the Firecracker host-to-guest vsock transport only. It does not test the Node Agent, jailer, systemd template, tenant isolation, workspace tools, browser, or Zendriver. Do not copy these images into `/srv/trinity-node/images` or enable guest routing with them.

### Development guest with actual tools and Zendriver

The experimental whole-desktop guest is selected explicitly with `--desktop` on the guest image builder and `GUEST_DESKTOP_ENABLED=1` on the matching Browser Runtime. It requires the browser-only Node Agent route and a new guest generation. Its profile migration changes ownership within the existing browser data directory; older images cannot use that directory again until ownership is restored through a reviewed, offline maintenance procedure. The local development node has been updated after disposable direct-VMM and jailer checks, with the previous image and an offline disk copy retained. Production deployment still requires the remaining ownership, rollback and isolation gates in [guest-desktop-design.md](../../docs/guest-desktop-design.md).

After the disposable transport check passes, prepare a separate guest that runs the actual `apps/guest-runtime`. The ordinary-user preparation snapshots an explicit allowlist of source, bundled skills and installed dependencies, the installed patched Zendriver 0.16.37 and Chrome, and downloads standalone Node 22.22.1 with its upstream SHA-256. It excludes `.env`, repository history, workspaces and browser profiles. These are local development artifacts, not a reproducible production release.

```bash
bash scripts/prepare-firecracker-guest.sh
sudo bash scripts/build-firecracker-guest.sh
bash scripts/run-firecracker-guest-test.sh
```

Preparation writes `~/.local/share/trinity/guest-payload`. The sudo builder creates a fresh Ubuntu Noble rootfs under `~/.local/share/trinity/firecracker-guest`, installs Chrome's runtime libraries and the existing guest systemd/vsock units, and checks all three executables against the guest libraries. It uses the current host kernel and matching modules, udev device discovery, a read-only rootfs, and a separate disposable data disk with workspace/browser directories owned by guest UID 1000. No existing disk or host configuration is replaced. The minimal debootstrap stage is followed by APT installation of browser libraries with the explicit `dbus-user-session` provider; service startup is suppressed during image creation, and `dpkg --audit` must be clean. Builds refuse existing destinations. If bootstrap or package installation failed before any disk image was created, retry with:

```bash
sudo bash scripts/build-firecracker-guest.sh --restart-incomplete
```

This preserves the marked incomplete directory and logs under a unique `.failed-<timestamp>-<pid>` sibling before rebuilding. Recovery preserves the whole existing image directory without modifying it. It rejects an unrecognized marker, a running Firecracker process or a mounted build filesystem. It never deletes a failed build. Allow at least 12 GiB free for the image build.

The guest acceptance runner invokes Node.js and the repository-installed `tsx` directly, so it also works with a restricted operator `PATH` (for example under `runuser`) without a global `pnpm` command. It checks these dependencies before starting a VMM. The kernel and read-only rootfs are checksum verified. The data disk is writable and changes during use, so its initial builder hash is informational and is deliberately excluded from subsequent image verification. The runner boots Firecracker directly twice with no network interface, preserving the disposable data disk and changing the generation. Through the real vsock relay it checks file persistence, non-root execution, scrubbed process environment, bundled skill discovery and guest rejection of a stale generation. Each boot also runs patched Zendriver and Chrome against an in-guest localhost fixture and saves preview JSON and PNG files under `firecracker-guest/run`. It closes browser/fixture processes, syncs data and stops the VMM. Boot failures show the console log. A successful result validates these development guest operations; jailer, Node Agent/PG assignment, network policy and tenant isolation still require their own acceptance. Keep these host-kernel images separate from `/srv/trinity-node/images` and keep production routing disabled until those gates pass.

The browser rootfs includes `fontconfig` and `fonts-noto-cjk` (Chinese, Japanese and Korean). Builds populate the font cache and reject missing representative CJK glyphs; guest acceptance checks coverage as UID 1000 and saves a multilingual preview for visual inspection. Missing remote glyphs require fonts inside the guest, rather than frontend fonts or a language pack. Existing immutable images need the rebuild/replacement procedure below and a fresh guest generation; keep each user’s data disk intact. The local browser-runtime Docker image installs the same fonts for deployments that run Chrome outside Firecracker.

The current acceptance also requires typed `FILE_NOT_FOUND` replies for missing text and binary files, followed by a healthy read of the persistence marker. This distinguishes an expected file error from broken guest transport. Control-plane readers must be upgraded before deploying the guest writer. An old guest still boots with the new control plane, but reports generic errors and fails this new acceptance check until rebuilt.

Guest code is snapshotted into `guest-payload/runtime.tar` and then into the immutable rootfs. Editing the repository or restarting the Node Agent does not update a running guest. To refresh an existing development deployment, preserve the old payload under a unique backup name before rerunning preparation, preserve/rebuild the marked development image with `--restart-incomplete`, and rerun direct guest acceptance. Schedule an idle-host maintenance window before installing a changed base image: suspend affected environments through the authenticated control plane, confirm their VMM units have stopped, and preserve the old verified shared image directory for rollback. The image installer deliberately refuses replacing a different existing image set; the operator must explicitly archive that base-image directory before installing the verified replacement. Keep per-user `volumes/*/data.ext4`, runtime metadata and network namespaces intact. Wake through the control plane for a new generation after installation and validate owner routing again. The disposable acceptance data disk must never replace a user's volume.

### Jailer, systemd, and isolated network acceptance

With the Node Agent lifecycle checks passing, the live database can be checked without creating an owner or environment row:

```bash
node_modules/.bin/tsx scripts/firecracker-node-agent-check.ts
```

This starts a temporary loopback-only Node Agent with an ephemeral token and a restricted environment, connects to the configured PostgreSQL database, and verifies that unknown environment and guest assignments return 409. It stops the process and writes no rows. A successful check proves PostgreSQL-backed denial; a real user request still requires an assigned environment.

To exercise the installed jailer and systemd unit with the real development guest:

```bash
sudo bash scripts/run-firecracker-jailer-test.sh
```

The root-owned runner requires `/srv/trinity-node` to have the explicit `development-unencrypted` marker and no active Trinity VM. It accepts either an empty `images` directory or the matching verified development kernel/rootfs; temporary copies are removed after the run, while preinstalled base images are preserved. By default it creates a random environment, uid/gid, disposable data disk, TAP device and isolated network namespace, installs default-drop nftables rules, and confirms guest egress is denied. It boots two generations through `jailer` and the actual `trinity-vm@` systemd unit. RPC, persistent data, stale-generation rejection, non-root tools, Zendriver screenshots and secret scrubbing are checked. It stops each unit before proceeding and removes its generated host assets after confirmed stop. Reports, PNGs and the unit journals remain in `~/.local/share/trinity/firecracker-jailer-test`.

For a separately built desktop candidate, pass `--desktop --guest-root /home/OPERATOR/.local/share/trinity/CANDIDATE` to the runner. It waits for the isolated browser service and checks desktop dialog and bookmark interaction in each generation. The image installer also accepts `--guest-root` for a separately built candidate. The same idle-host and matching-image guards apply; use the maintenance gate and preserve the existing shared image for rollback before changing it. Both scripts accept the operator identity supplied by `pkexec` as well as `sudo`.

To check host-routed egress too, select an operator-approved hostname and TCP port. This mode requires the host gateway above to be active:

```bash
sudo env TRINITY_EGRESS_TEST_HOST=approved-hostname.example TRINITY_EGRESS_TEST_PORT=443 \
  bash scripts/run-firecracker-jailer-test.sh --check-network-egress
```

The guest attempts DNS resolution and a TCP connection during both generations. The default-deny test remains available with `--check-network-denied`. Both modes are development acceptance only; neither validates the owner-assignment route or production tenant isolation.

Install the immutable development base images for a later owner-assignment run:

```bash
sudo bash scripts/install-firecracker-development-images.sh
```

This copies only the verified kernel and read-only rootfs into `/srv/trinity-node/images`. It refuses to replace an existing image set and does not create a user data disk, environment assignment, VM, or network namespace. Keep `data.ext4` out of this shared directory; each environment needs its own separately provisioned writable disk.

If the VMM stop cannot be confirmed, the runner retains its instance, volume, namespace and image assets for recovery. Do not delete them until the matching systemd unit and VMM process are confirmed stopped. This checks local jailer/systemd/vsock behavior under an isolated development node; it does not create a PostgreSQL assignment or claim production tenant isolation.

Install the Node Agent service from this repository checkout and the Node 22 executable used by this checkout:

```bash
sudo bash scripts/install-firecracker-node-agent.sh "$(command -v node)"
sudoedit /etc/trinity/node-agent.env
```

The installer creates a root-owned environment file from `node-agent.env.example`, installs a root-managed systemd unit and fixed launcher, and does not enable or start the service. It isolates the agent from the repository `.env`, so provider/model credentials are not loaded into this privileged process. Fill in `DATABASE_URL` and a dedicated token generated with `openssl rand -hex 32`; keep the file root-owned and mode `0600`.

Run the repository's `apps/node-agent` with these private environment variables in `/etc/trinity/node-agent.env`:

```text
DATABASE_URL=<control database connection>
NODE_ID=local-kvm-01
NODE_STATE_DIR=/srv/trinity-node
NODE_DEPLOYMENT_MODE=production
NODE_STORAGE_ENCRYPTION=provider-managed # or host-managed for LUKS/host storage encryption
NODE_RUNTIME_TOKEN=<same dedicated token configured on the control plane>
NODE_PORT=3030
WORKSPACE_ROOT=/workspace
NODE_GUEST_ROUTING=false # true only with provisioned, validated guest supervisor
```

For the explicitly unencrypted local development host, use `NODE_DEPLOYMENT_MODE=development` and `NODE_STORAGE_ENCRYPTION=none`. The Node Agent rejects `none` in production mode. The encryption mode is an operator attestation; it does not inspect mount, provider, snapshot, or backup settings. After editing the environment file, start the host service with `sudo systemctl enable --now trinity-node-agent.service`. It binds only to loopback. This service requires host privileges for fixed systemd operations; do not run it inside a user microVM. Its database/management credentials are never passed to Firecracker or guest processes.

For the local control-plane process on the same host, configure its `.env` with the matching inventory and token:

```dotenv
FIRECRACKER_NODES=[{"id":"local-kvm-01","endpoint":"http://127.0.0.1:3030/","vcpus":2,"memoryMiB":4096}]
NODE_RUNTIME_TOKEN=<same dedicated token>
```

This loopback endpoint is only valid when the control plane runs on the same host. A remote or K8s control plane needs an operator-managed TLS/mTLS endpoint; never expose the Node Agent port directly. Restart the local server after changing `.env`. `EXECUTION_DRIVER=firecracker` is a separate opt-in and must be set consistently on server, agent-worker, and browser-runtime before guest tools are routed.

The control plane first assigns a stable environment ID. Use it to prepare the per-user data volume, `runtime.json`, and namespace before expecting a successful boot. Missing files or namespaces cause a failed unit, without creating a blank replacement user disk. Guest egress becomes available after the optional host gateway is installed; Node Agent configures each environment namespace automatically on authenticated start. `SANDBOX_PROXY_URL` selects the host-provided egress for the whole guest through the normal installer; provider selection and destination allow/deny lists remain operator-managed. Do not expose the host's loopback proxy as a guest endpoint. The first authenticated wake currently attempts the start immediately; if assets are not ready, use the resulting operator manifest to provision them, then suspend and wake for a fresh generation:

```bash
sudo find /srv/trinity-node/instances -maxdepth 1 -type f -name '*.json' -printf '%f\n'
sudo bash scripts/provision-firecracker-development-environment.sh \
  /srv/trinity-node/instances/<environment-id>-<generation>.json
```

This provisioning script is limited to `development-unencrypted` storage. It creates a fresh per-environment data disk and isolated namespace; when the optional host gateway is active, it adds the host-routed IPv4 path. It refuses existing volumes/namespaces. Per-user volume/network provisioning is still an operator step, not an automatic user-computer provisioner. Guest supervisor, vsock bridge and execution configuration are described in [runtime implementation](../../docs/runtime-implementation.md#实验性-guest-执行面).

## Public browser acceptance on an assigned guest

Docker is not a Firecracker dependency. The `DOCKER-USER` rules above are only needed when a separately installed Docker daemon changes this host’s forwarding firewall. A working NAT route still does not make a host application proxy apply to guest packets.

The forwarding unit tests fake firewall commands; the local Zendriver fixtures use localhost. Neither establishes public browsing or Google Search availability. To check the current assigned guest without running disposable image/jailer acceptance, select an idle personal session owned by the configured browser owner:

```bash
FIRECRACKER_BROWSER_INTEGRATION=1 \
FIRECRACKER_BROWSER_TEST_SESSION_ID=<existing-personal-session-uuid> \
pnpm exec vitest run apps/browser-runtime/test/firecracker-browser-integration.test.ts
```

This explicit opt-in loads the configured Firecracker deployment, resolves the authenticated owner and running assignment from PostgreSQL, and executes the typed browser tool through Node Agent, vsock and guest Chrome. It checks public HTTPS text/receipts and `web_search` separately. It never substitutes local browser execution or passes host proxy credentials into the guest. Existing profile leases remain enforced. Its evidence/artifacts stay in a temporary test store, so it does not append a synthetic user turn to the selected production session. A separate case covers human return, browser disposal/recreation and both model-card searches through private HTTP and isolated PostgreSQL runtime/control journals. Test events and artifacts stay outside the production session history; the test journal schema is removed after cleanup. This does not validate ACP dispatch, real-model research interpretation or production isolation.

These are live acceptance checks, skipped by default CI. A public-page pass and a Google Search failure means the selected search destination still needs network/DNS/proxy investigation; the first pass is not sufficient to declare browser research working. A search redirect to an access/challenge page also fails the search check. Ordinary unit tests remain deterministic and offline.

## Operation and recovery

The private `/instances` endpoint accepts only typed `start`, `stop` and `status` commands, authenticated and checked against the current PG owner/node/generation/resource assignment. The host uses a fixed `trinity-vm@<environment-id>-<generation>.service`, bounded literal systemctl argv, per-unit memory/CPU limits, jailer and the preconfigured network namespace. It never executes a client-supplied shell command or executable.

`running` means only that the unit is active. Guest readiness, file/browser tool availability and isolation require separate checks before execution-plane integration can be enabled. Node Agent restart does not stop existing systemd-owned VMs.

After a timeout or disconnected host, the control plane quarantines the environment and retains its capacity reservation. It does not allocate another host. Restore management connectivity, inspect the matching systemd unit and confirm all owned VMM processes have stopped; then use the authenticated suspend operation to record a confirmed stop. Only afterward may wake reserve a fresh generation on the same host. Keep the private data disk. Cross-host migration, automatic stale-host takeover, snapshot restore and idle eviction are not implemented.
