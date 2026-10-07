#define _GNU_SOURCE
#include <fcntl.h>
#include <linux/io_uring.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

static void require(int ok, const char *what) {
    if (!ok) { perror(what); exit(2); }
}

int main(int argc, char **argv) {
    require(argc == 4, "arguments");
    int group = open(argv[1], O_WRONLY | O_CLOEXEC);
    require(group >= 0, "open cgroup.procs");
    char pid[32];
    int n = snprintf(pid, sizeof(pid), "%d", getpid());
    require(write(group, pid, n) == n, "enter child cgroup");
    close(group);
    int target = open(argv[2], O_WRONLY | O_CLOEXEC);
    require(target >= 0, "open target");
    struct io_uring_params p = {0};
    if (strcmp(argv[3], "sqpoll") == 0) {
        p.flags = IORING_SETUP_SQPOLL;
        p.sq_thread_idle = 10000;
    }
    int ring = syscall(__NR_io_uring_setup, 8, &p);
    require(ring >= 0, "io_uring_setup");
    size_t sq_size = p.sq_off.array + p.sq_entries * sizeof(unsigned);
    size_t cq_size = p.cq_off.cqes + p.cq_entries * sizeof(struct io_uring_cqe);
    if (p.features & IORING_FEAT_SINGLE_MMAP) {
        if (cq_size > sq_size) sq_size = cq_size;
    }
    void *sq = mmap(NULL, sq_size, PROT_READ | PROT_WRITE, MAP_SHARED, ring, IORING_OFF_SQ_RING);
    require(sq != MAP_FAILED, "map SQ");
    void *cq = sq;
    if (!(p.features & IORING_FEAT_SINGLE_MMAP)) {
        cq = mmap(NULL, cq_size, PROT_READ | PROT_WRITE, MAP_SHARED, ring, IORING_OFF_CQ_RING);
        require(cq != MAP_FAILED, "map CQ");
    }
    struct io_uring_sqe *entries = mmap(NULL, p.sq_entries * sizeof(*entries),
        PROT_READ | PROT_WRITE, MAP_SHARED, ring, IORING_OFF_SQES);
    require(entries != MAP_FAILED, "map SQEs");
    const char bytes[] = "outside-latest\n";
    entries[0].opcode = IORING_OP_POLL_ADD;
    entries[0].fd = STDIN_FILENO;
    entries[0].poll_events = POLLIN;
    entries[0].flags = IOSQE_IO_LINK;
    entries[0].user_data = 1;
    entries[1].opcode = IORING_OP_WRITE;
    entries[1].fd = target;
    entries[1].addr = (unsigned long)bytes;
    entries[1].len = sizeof(bytes) - 1;
    entries[1].off = 0;
    entries[1].user_data = 2;
    unsigned *array = sq + p.sq_off.array;
    array[0] = 0;
    array[1] = 1;
    __atomic_store_n((unsigned *)(sq + p.sq_off.tail), 2, __ATOMIC_RELEASE);
    require(syscall(__NR_io_uring_enter, ring, 2, 0,
        p.flags & IORING_SETUP_SQPOLL ? IORING_ENTER_SQ_WAKEUP : 0, NULL, 0) >= 0, "submit");
    puts("READY");
    fflush(stdout);
    for (;;) pause();
}
