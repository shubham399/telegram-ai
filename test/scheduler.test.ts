/**
 * In-process scheduler: due-job dispatch, crash recovery and plain reminders.
 *
 * The two behaviours that matter most are both regressions this replaced: a plain
 * reminder must cost zero model calls, and a task left INPROGRESS by a killed
 * process must be requeued with its recurring job re-armed.
 */
import { freshDb, check, section, summary } from './helpers'
import { JobStore } from '../src/job-store'
import { TaskStore } from '../src/task-store'
import { startScheduler } from '../src/scheduler'

const db = freshDb()
const jobs = new JobStore(db)
const tasks = new TaskStore(db)
const sent: string[] = []
let modelCalls = 0

const send = async (_userId: string, text: string): Promise<boolean> => {
  sent.push(text)
  return true
}

const scheduler = startScheduler({
  jobStore: jobs,
  taskStore: tasks,
  send,
  // Stands in for task-runner: mark in-progress, run, record, deliver, advance.
  runTask: async task => {
    modelCalls++
    tasks.setInProgress(task.id)
    tasks.setSuccess(task.id, 'ai answer')
    await send(task.telegramUserId, 'ai answer')
    jobs.afterRun(task.jobId)
  },
})

/** Make a job due right now. */
function makeDue(jobId: number): void {
  db.run(`UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?`, [new Date(Date.now() - 60_000).toISOString(), jobId])
}
const jobRow = (id: number) => db.query('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as any

section('a plain reminder is delivered without a model call')
const reminder = jobs.create('user-1', 'stand up', 'once', 9, 30, undefined, false).id
makeDue(reminder)
await scheduler.tick()
check('the reminder was delivered', true, sent.some(t => t.includes('stand up')))
check('no model call was made', 0, modelCalls)
check('the job is marked as run', true, jobRow(reminder).last_run_at !== null)
check('a once job is retired after firing', false, !!jobRow(reminder).active)

section('an AI task runs the agent and delivers its answer')
const aiJob = jobs.create('user-1', 'summarise my inbox', 'once', 9, 31, undefined, true).id
makeDue(aiJob)
await scheduler.tick()
check('the model was called once', 1, modelCalls)
check('the answer was delivered', true, sent.some(t => t.includes('ai answer')))

section('a task interrupted by a crash is requeued')
const orphanJob = jobs.create('user-1', 'long running thing', 'once', 9, 32, undefined, true).id
makeDue(orphanJob)
const orphan = tasks.create(orphanJob, 'user-1', 'long running thing')
tasks.setInProgress(orphan.id)
check('the task is INPROGRESS before recovery', 'INPROGRESS', tasks.getById(orphan.id)?.status)
scheduler.recover()
check('requeued to NEW', 'NEW', tasks.getById(orphan.id)?.status)

section('recovery runs a requeued task on the next tick')
const before = modelCalls
await scheduler.tick()
check('the model ran again', before + 1, modelCalls)

section('a recurring job re-arms instead of firing forever')
const recurring = jobs.create('user-1', 'daily standup', 'daily', 9, 33).id
makeDue(recurring)
await scheduler.tick()
check('still active', true, !!jobRow(recurring).active)
check('next_run_at is in the future', true, new Date(jobRow(recurring).next_run_at).getTime() > Date.now())

section('a tick does not overlap itself')
// An isolated database: this asserts about concurrency only, so it must not
// inherit whatever jobs the earlier sections left behind.
const iso = freshDb()
const isoJobs = new JobStore(iso)
const isoTasks = new TaskStore(iso)
let concurrent = 0
let maxConcurrent = 0
const slow = startScheduler({
  jobStore: isoJobs,
  taskStore: isoTasks,
  send: async () => true,
  runTask: async task => {
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    await new Promise(r => setTimeout(r, 30))
    concurrent--
    isoTasks.setSuccess(task.id, 'slow answer')
    isoJobs.afterRun(task.jobId)
  },
})
const slowJob = isoJobs.create('user-1', 'slow task', 'once', 9, 34, undefined, true).id
iso.run(`UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?`, [
  new Date(Date.now() - 60_000).toISOString(),
  slowJob,
])
await Promise.all([slow.tick(), slow.tick(), slow.tick()])
check('three simultaneous ticks ran the work exactly once', 1, maxConcurrent)
check('only one task row was created', 1, isoTasks.getByJobId(slowJob).length)
slow.stop()
iso.close()

section('stop() halts the loop')
scheduler.stop()
const callsAtStop = modelCalls
await scheduler.tick()
check('no further model calls after stop', callsAtStop, modelCalls)

db.close()
summary()
