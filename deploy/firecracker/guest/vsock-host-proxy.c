/*
 * Accept a systemd-activated connection only from Firecracker's host CID,
 * then relay it to the browser service's fixed private Unix socket. Workspace
 * processes must not be able to access that socket or impersonate the host.
 * The proxy does not parse, log, or retain browser traffic.
 */
#include <errno.h>
#include <fcntl.h>
#include <linux/vm_sockets.h>
#include <poll.h>
#include <stddef.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define BUFFER_SIZE 16384
#define IDLE_TIMEOUT_MS 130000
#define BROWSER_SOCKET "/run/trinity-browser/rpc.sock"

struct direction {
  int source;
  int destination;
  unsigned char data[BUFFER_SIZE];
  size_t start;
  size_t end;
  int eof;
  int shutdown_sent;
};

static int nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 ? -1 : 0;
}

static int allowed_peer(const struct sockaddr_vm *peer, socklen_t length) {
  return length >= sizeof(*peer) && peer->svm_family == AF_VSOCK &&
         peer->svm_cid == VMADDR_CID_HOST;
}

static int read_into(struct direction *d) {
  ssize_t count = read(d->source, d->data + d->end, BUFFER_SIZE - d->end);
  if (count == 0) d->eof = 1;
  else if (count > 0) d->end += (size_t)count;
  else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return -1;
  return 0;
}

static int write_from(struct direction *d) {
  ssize_t count = send(d->destination, d->data + d->start, d->end - d->start, MSG_NOSIGNAL);
  if (count > 0) {
    d->start += (size_t)count;
    if (d->start == d->end) d->start = d->end = 0;
  } else if (count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) return -1;
  return 0;
}

int main(void) {
  struct sockaddr_vm peer;
  socklen_t length = sizeof(peer);
  memset(&peer, 0, sizeof(peer));
  if (getpeername(STDIN_FILENO, (struct sockaddr *)&peer, &length) != 0 ||
      !allowed_peer(&peer, length))
    return 77;

  int local = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (local < 0) return 1;
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, BROWSER_SOCKET, sizeof(BROWSER_SOCKET));
  if (connect(local, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      nonblocking(STDIN_FILENO) != 0 || nonblocking(local) != 0) {
    close(local);
    return 1;
  }
  struct direction d[2] = {
    {.source = STDIN_FILENO, .destination = local},
    {.source = local, .destination = STDIN_FILENO},
  };
  int result = 0;
  for (;;) {
    for (int i = 0; i < 2; i++) {
      if (d[i].eof && d[i].start == d[i].end && !d[i].shutdown_sent) {
        if (shutdown(d[i].destination, SHUT_WR) != 0 && errno != ENOTCONN) {
          result = 1;
          goto done;
        }
        d[i].shutdown_sent = 1;
      }
    }
    if (d[0].shutdown_sent && d[1].shutdown_sent) break;
    struct pollfd fds[2] = {
      {.fd = STDIN_FILENO},
      {.fd = local},
    };
    for (int i = 0; i < 2; i++) {
      if (!d[i].eof && d[i].end < BUFFER_SIZE) fds[i].events |= POLLIN;
      if (d[i].start < d[i].end) fds[1 - i].events |= POLLOUT;
    }
    int ready = poll(fds, 2, IDLE_TIMEOUT_MS);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) { result = 1; break; }
    for (int i = 0; i < 2; i++) {
      if (fds[i].revents & (POLLERR | POLLNVAL)) { result = 1; goto done; }
      if ((fds[i].revents & (POLLIN | POLLHUP)) && !d[i].eof && d[i].end < BUFFER_SIZE && read_into(&d[i]) != 0) {
        result = 1; goto done;
      }
      if ((fds[1 - i].revents & POLLOUT) && d[i].start < d[i].end && write_from(&d[i]) != 0) {
        result = 1; goto done;
      }
    }
  }
done:
  close(local);
  return result;
}
