# Dedicated KVM node: initial lifecycle adapter

This is the opt-in host power/capacity layer for the [personal runtime proposal](../../docs/personal-assistant-runtime-architecture.md). The local development guest has passed real KVM, jailer/systemd, persistence, Zendriver, and default-deny egress acceptance. Live owner-scoped PostgreSQL routing and production isolation remain rollout gates. K8s continues hosting the control plane; this agent runs on the KVM host.

## Operator prerequisites

- Linux/KVM, systemd/cgroup v2, `jq`, Node 22+, and independently verified matching musl Firecracker/jailer binaries at `/usr/local/bin/firecracker` and `/usr/local/bin/jailer`. Follow the [official jailer guidance](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md).
- A root-owned filesystem at `/srv/trinity-node`, mode `0700`, with an explicit storage policy. Production requires `NODE_STORAGE_ENCRYPTION=host-managed` or `provider-managed`; both are operator attestations, not automatic encryption detection. `none` is accepted only with `NODE_DEPLOYMENT_MODE=development`.
- Approved `images/vmlinux` and read-only `images/rootfs.ext4`. The guest image must support the supplied virtio disks/network, booting a read-only root and mounting its private data disk. No image is downloaded or manufactured automatically.
- A per-environment `volumes/<environment-id>/data.ext4` and root-owned `runtime.json`, containing unique non-root numeric `uid` and `gid` (both at least 100000). Reserve those IDs per environment. Backing files and images must reside on the same filesystem because the launcher uses hard links. Production storage must be encrypted at the host or provider layer; explicit development mode may use unencrypted local storage and does not establish tenant isolation.
- An operator-provisioned `/run/netns/trinity-<environment-id>` containing `tap0`, isolated from other users and with host-enforced default-deny egress plus approved proxy/DNS rules. The namespace's existence is a prerequisite, not proof that its firewall is correct.

The node ID, endpoint and admitted CPU/memory capacity must agree with the server's `FIRECRACKER_NODES`. Never point this inventory at a user-controlled endpoint. Remote management requires an operator-authenticated TLS/mTLS proxy; the Node Agent itself listens only on loopback. Keep CDP, Firecracker API sockets and guest RPC off the public network.

## Installation

On a supported KVM host, install the pinned Firecracker v1.17.0 and jailer binaries, `jq` if missing, the VM template unit, and the fixed launcher with:

```bash
sudo bash scripts/install-firecracker-host.sh
```

The installer checks `/dev/kvm`, downloads the official x86_64 or aarch64 release over HTTPS, verifies the pinned SHA-256, and copies only the two expected regular executables. It does not enable or start any VM. It also does not encrypt storage or create guest images, per-user disks, or network namespaces. Keep the unit/launcher, images, manifests and volume metadata inaccessible to user workloads.

The installed binaries are Firecracker v1.17.0, a supported upstream release as of this guide. Upgrade the pinned version and both architecture checksums together after reviewing upstream release notes. See the [official release](https://github.com/firecracker-microvm/firecracker/releases/tag/v1.17.0) and [release policy](https://github.com/firecracker-microvm/firecracker/blob/main/docs/RELEASE_POLICY.md).

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

The kernel and read-only rootfs are checksum verified. The data disk is writable and changes during use, so its initial builder hash is informational and is deliberately excluded from subsequent image verification. The runner boots Firecracker directly twice with no network interface, preserving the disposable data disk and changing the generation. Through the real vsock relay it checks file persistence, non-root execution, scrubbed process environment, bundled skill discovery and guest rejection of a stale generation. Each boot also runs patched Zendriver and Chrome against an in-guest localhost fixture and saves preview JSON and PNG files under `firecracker-guest/run`. It closes browser/fixture processes, syncs data and stops the VMM. Boot failures show the console log. A successful result validates these development guest operations; jailer, Node Agent/PG assignment, network policy and tenant isolation still require their own acceptance. Keep these host-kernel images separate from `/srv/trinity-node/images` and keep production routing disabled until those gates pass.

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

The root-owned runner requires `/srv/trinity-node` to have the explicit `development-unencrypted` marker and no active Trinity VM. It accepts either an empty `images` directory or the matching verified development kernel/rootfs; temporary copies are removed after the run, while preinstalled base images are preserved. It creates a random environment, uid/gid, disposable data disk, TAP device and isolated network namespace, then installs default-drop nftables rules. It boots two generations through `jailer` and the actual `trinity-vm@` systemd unit. RPC, persistent data, stale-generation rejection, non-root tools, Zendriver screenshots, secret scrubbing and a guest outbound-connect denial are checked. It stops each unit before proceeding and removes its generated host assets after confirmed stop. Reports, PNGs and the unit journals remain in `~/.local/share/trinity/firecracker-jailer-test`. This local development acceptance has passed; it is separate from the real owner-assignment route below.

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

The control plane first assigns a stable environment ID. Use it to prepare the per-user data volume, `runtime.json`, and namespace before expecting a successful boot. Missing files or namespaces cause a failed unit, without creating a blank replacement user disk. The first authenticated wake currently attempts the start immediately; if assets are not ready, use the resulting operator manifest to provision them, then suspend and wake for a fresh generation:

```bash
sudo find /srv/trinity-node/instances -maxdepth 1 -type f -name '*.json' -printf '%f\n'
sudo bash scripts/provision-firecracker-development-environment.sh \
  /srv/trinity-node/instances/<environment-id>-<generation>.json
```

This provisioning script is limited to `development-unencrypted` storage. It creates a fresh per-environment data disk and a default-deny network namespace with no external guest egress; it refuses existing volumes/namespaces. Per-user volume/network provisioning is still an operator step, not an automatic user-computer provisioner. Guest supervisor, vsock bridge and execution configuration are described in [runtime implementation](../../docs/runtime-implementation.md#实验性-guest-执行面).

## Operation and recovery

The private `/instances` endpoint accepts only typed `start`, `stop` and `status` commands, authenticated and checked against the current PG owner/node/generation/resource assignment. The host uses a fixed `trinity-vm@<environment-id>-<generation>.service`, bounded literal systemctl argv, per-unit memory/CPU limits, jailer and the preconfigured network namespace. It never executes a client-supplied shell command or executable.

`running` means only that the unit is active. Guest readiness, file/browser tool availability and isolation require separate checks before execution-plane integration can be enabled. Node Agent restart does not stop existing systemd-owned VMs.

After a timeout or disconnected host, the control plane quarantines the environment and retains its capacity reservation. It does not allocate another host. Restore management connectivity, inspect the matching systemd unit and confirm all owned VMM processes have stopped; then use the authenticated suspend operation to record a confirmed stop. Only afterward may wake reserve a fresh generation on the same host. Keep the private data disk. Cross-host migration, automatic stale-host takeover, snapshot restore and idle eviction are not implemented.
