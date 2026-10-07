"""Bounded, synchronized filesystem attacker for supplemental local tests.

This is not installed in the release bundle and grants no root authority.
"""
import queue
import threading


class RaceSchedule:
    def __init__(self, mutation):
        self.requests = queue.Queue()
        self.results = queue.Queue()
        self.mutation = mutation
        self.worker = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while self.requests.get() is not None:
            try:
                self.mutation()
                self.results.put(None)
            except BaseException as error:
                self.results.put(error)

    def __enter__(self):
        self.worker.start()
        return self

    def replace(self):
        self.requests.put(True)
        result = self.results.get(timeout=5)
        if result is not None:
            raise result

    def __exit__(self, *args):
        self.requests.put(None)
        self.worker.join(timeout=5)
        if self.worker.is_alive():
            raise RuntimeError("filesystem attacker did not stop")
