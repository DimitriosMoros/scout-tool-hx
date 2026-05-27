/**
 * In-memory job store for background scrape jobs.
 * Supports cancellation — check isCancelled(id) inside long-running loops.
 */

const jobs = new Map();

export const jobStore = {
  create(id, meta) {
    jobs.set(id, {
      id, status: 'queued', progress: 0, message: 'Queued…',
      result: null, error: null, cancelled: false,
      ...meta, createdAt: Date.now(),
    });
  },
  update(id, updates) {
    const job = jobs.get(id);
    if (job) jobs.set(id, { ...job, ...updates, updatedAt: Date.now() });
  },
  fail(id, error) {
    const job = jobs.get(id);
    if (job) jobs.set(id, { ...job, status: 'error', error, updatedAt: Date.now() });
  },
  cancel(id) {
    const job = jobs.get(id);
    if (job) jobs.set(id, { ...job, cancelled: true, updatedAt: Date.now() });
    return !!job;
  },
  isCancelled(id) {
    return jobs.get(id)?.cancelled === true;
  },
  get(id) {
    return jobs.get(id) || null;
  },
  prune() {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, job] of jobs) {
      if (job.createdAt < cutoff) jobs.delete(id);
    }
  },
};

setInterval(() => jobStore.prune(), 30 * 60 * 1000);