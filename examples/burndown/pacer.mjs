#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function number(value, name, minimum = 0, exclusive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      (exclusive ? value <= minimum : value < minimum)) {
    throw new Error(`${name} must be a finite number ${exclusive ? 'greater than' : 'at least'} ${minimum}`);
  }
  return value;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function pace(input) {
  const data = object(input, 'input');
  const now = number(data.now, 'now');
  const resetAt = number(data.resetAt, 'resetAt');
  const remaining = number(data.remaining, 'remaining');
  let usagePerJob = number(data.usagePerJob, 'usagePerJob', 0, true);
  const jobSeconds = number(data.jobSeconds, 'jobSeconds', 0, true);
  const alpha = number((data.alpha === undefined ? 0.3 : data.alpha), 'alpha', 0, true);
  if (alpha > 1) throw new Error('alpha must be at most 1');
  const samples = data.samples === undefined ? [] : data.samples;
  if (!Array.isArray(samples)) throw new Error('samples must be an array');
  for (const sample of samples) {
    usagePerJob = alpha * number(sample, 'sample') + (1 - alpha) * usagePerJob;
  }
  const maxConcurrency = number((data.maxConcurrency === undefined ? 24 : data.maxConcurrency), 'maxConcurrency');
  if (!Number.isSafeInteger(maxConcurrency)) throw new Error('maxConcurrency must be a safe integer');
  const machine = object(data.machine, 'machine');
  const cpu = number(machine.cpu, 'machine.cpu');
  const memory = number(machine.memoryMb, 'machine.memoryMb');
  const reserveCpu = number((machine.reserveCpu === undefined ? 1 : machine.reserveCpu), 'machine.reserveCpu');
  const reserveMemory = number((machine.reserveMemoryMb === undefined ? 1024 : machine.reserveMemoryMb), 'machine.reserveMemoryMb');
  const cpuPerJob = number((machine.cpuPerJob === undefined ? 1 : machine.cpuPerJob), 'machine.cpuPerJob', 0, true);
  const memoryPerJob = number((machine.memoryPerJobMb === undefined ? 1024 : machine.memoryPerJobMb), 'machine.memoryPerJobMb', 0, true);
  const machineLimit = Math.min(Number.MAX_SAFE_INTEGER,
    Math.floor(Math.max(0, cpu - reserveCpu) / cpuPerJob),
    Math.floor(Math.max(0, memory - reserveMemory) / memoryPerJob));
  let pacedJobs = (remaining / usagePerJob) * (jobSeconds / (resetAt - now));
  if (!Number.isFinite(pacedJobs) && remaining > 0 && usagePerJob > 0 && resetAt > now) {
    pacedJobs = Math.exp(Math.log(remaining) - Math.log(usagePerJob) +
      Math.log(jobSeconds) - Math.log(resetAt - now));
  }
  const quotaLimit = resetAt <= now || usagePerJob === 0 || remaining === 0 ? 0 : Math.min(
    Number.MAX_SAFE_INTEGER, Math.floor(remaining / usagePerJob), Math.floor(pacedJobs));
  return { concurrency: Math.min(maxConcurrency, machineLimit, quotaLimit), usagePerJob, machineLimit, quotaLimit };
}

try {
  if (process.argv.length !== 2) throw new Error('Usage: pacer.mjs < snapshot.json');
  console.log(JSON.stringify(pace(JSON.parse(readFileSync(0, 'utf8')))));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
