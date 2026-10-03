# C-COL-03 The mutation lock: no writer loses a write or lands mid-rewrite

Folded into T-COL-03r’s FIFO executor tests, T-COL-03a’s freeze-sequence component tests and T-COL-03’s real-client writer matrix. Local capture pins and queues a snapshot without waiting for host acknowledgement. Delayed acknowledgements must not extend the freeze (C-PERF-06).
