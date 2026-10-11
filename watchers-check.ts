import { resolve } from "node:path";
import type { CheckResult, WatcherRecord } from "./watchers-types.js";

// One self-contained program, included verbatim in the launch/repeat command.
// No dependency on a mutable helper file, provider, or another extension's internals.
export const WATCHER_SUPERVISOR_SOURCE = String.raw`(function main() {
  const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto'), path = require('node:path');
  const spec = JSON.parse(process.argv[1]);
  const result = (kind, detail, extra = {}) => ({ version: 1, id: spec.id, kind, detail, output: '', omitted: false, ...extra });
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(0));
  const killGroup = pid => { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } };
  if (spec.worker) {
    // The parent's private pipe closes on parent death as well as normal cleanup.
    // Checks cannot inherit it. This is best effort, not protection from same-user code.
    process.stdin.on('end', () => killGroup(process.pid)); process.stdin.resume();
    let tail = '', omitted = false, finished = false;
    const append = data => { const text = data.toString('utf8'); tail += text; if (tail.length > spec.outputTailChars) { omitted = true; tail = tail.slice(-spec.outputTailChars); } };
    const done = value => { if (finished) return; finished = true; emit({ ...value, output: value.output || tail, omitted: value.omitted || omitted }); };
    const fail = () => done(result('failed', 'The check could not read or execute its target.'));
    const noLinks = target => {
      const absolute = path.resolve(target), parts = [];
      let current = absolute;
      while (path.dirname(current) !== current) { parts.push(current); current = path.dirname(current); }
      for (const part of parts.reverse()) if (fs.lstatSync(part).isSymbolicLink()) throw new Error('Symbolic link in target path');
      return absolute;
    };
    const env = { ...process.env };
    for (const key of ['PI_SESSION_ID','PI_SESSION_FILE','PI_PROVIDER','PI_MODEL','PI_REASONING_LEVEL']) delete env[key];
    try {
      process.chdir(spec.cwd);
      const condition = spec.condition;
      if (condition.kind === 'command') {
        const child = cp.spawn('/bin/sh', ['-c', condition.command], { cwd: spec.cwd, env, stdio: ['ignore','pipe','pipe'] });
        child.stdout.on('data', append); child.stderr.on('data', append);
        child.on('error', fail);
        child.on('close', (code, signal) => {
          child.stdout.destroy(); child.stderr.destroy();
          done(result(signal || code === null ? 'failed' : 'result', signal ? 'Check terminated by signal.' : '', { code: code === null ? undefined : code }));
        });
      } else if (condition.kind === 'file_lines') {
        let target;
        try { target = noLinks(condition.path); }
        catch (error) { if (error.code === 'ENOENT') { done(result('result', 'File does not exist yet.', { code: 1 })); return; } throw error; }
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); throw new Error('Not a regular file'); }
        let lines = 0;
        const stream = fs.createReadStream(target, { fd, autoClose: true });
        stream.on('data', chunk => { for (const byte of chunk) if (byte === 10) lines++; if (lines >= condition.minLines) { stream.destroy(); done(result('result', 'Required newline count reached.', { code: 0 })); } });
        stream.on('end', () => done(result('result', 'Required newline count not reached.', { code: 1 })));
        stream.on('error', fail);
      } else if (condition.kind === 'path_quiet') {
        const root = noLinks(condition.path), entries = [], pending = [[root, 0]];
        let bytes = 0;
        const over = () => done(result('refused', 'Quiet inventory exceeds its entry, depth, or 8 MiB metadata limit.'));
        const walk = async () => {
          while (pending.length) {
            const [target, depth] = pending.pop();
            if (depth > 64 || entries.length >= spec.maxDirectoryEntries) { over(); return; }
            const stat = fs.lstatSync(target, { bigint: true });
            const item = [path.relative(root, target), String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
            bytes += Buffer.byteLength(JSON.stringify(item));
            if (bytes > 8388608) { over(); return; }
            entries.push(item);
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
              const dir = await fs.promises.opendir(target);
              try {
                for await (const entry of dir) {
                  if (entries.length + pending.length >= spec.maxDirectoryEntries) { over(); return; }
                  pending.push([path.join(target, entry.name), depth + 1]);
                }
              } finally { try { await dir.close(); } catch {} }
            }
          }
          entries.sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
          done(result('result', 'Metadata inventory observed; quiet is not proof of success.', { code: 0, fingerprint: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') }));
        };
        walk().catch(fail);
      } else fail();
    } catch { fail(); }
  } else {
    const remaining = Math.min(spec.checkTimeoutSeconds * 1000, spec.deadline - Date.now());
    if (remaining <= 0) { emit(result('deadline', 'Watcher deadline reached.')); return; }
    let ended = false, text = '', timer;
    const child = cp.spawn(process.execPath, ['--input-type=commonjs', '-e', '(' + main.toString() + ')()', '--', JSON.stringify({ ...spec, worker: true })], { cwd: spec.cwd, detached: true, stdio: ['pipe','pipe','pipe'] });
    const finish = value => {
      if (ended) return; ended = true; clearTimeout(timer);
      if (child.pid) killGroup(child.pid);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      emit(value);
    };
    child.stdout.on('data', chunk => {
      text += chunk.toString('utf8');
      if (text.length > 32768) finish(result('failed', 'Invalid oversized check result.'));
    });
    // Worker stderr is not accumulated or logged. Worker errors have bounded notices.
    child.stderr.resume();
    child.on('error', () => finish(result('failed', 'Check worker could not start.')));
    child.on('close', () => {
      if (ended) return;
      try { const value = JSON.parse(text); if (value.id !== spec.id || value.version !== 1) throw new Error(); finish(value); }
      catch { finish(result('failed', 'Check worker failed without a valid result.')); }
    });
    timer = setTimeout(() => finish(result(Date.now() >= spec.deadline ? 'deadline' : 'failed', 'Check runtime limit reached.')), remaining);
    for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal, () => finish(result('failed', 'Check cancelled.')));
  }
})()`;

export function shellQuote(text: string): string { return `'${text.replace(/'/g, `'"'"'`)}'`; }
export function buildWatcherCommand(record: Omit<WatcherRecord, "command">): string {
	const spec = { id: record.id, cwd: resolve(record.cwd), condition: record.condition, deadline: record.deadline, checkTimeoutSeconds: record.checkTimeoutSeconds, outputTailChars: record.outputTailChars, maxDirectoryEntries: record.maxDirectoryEntries };
	// Explicit shell semantics; pi.exec later passes this exact string to /bin/sh -c.
	return `exec ${shellQuote(process.execPath)} --input-type=commonjs -e ${shellQuote(WATCHER_SUPERVISOR_SOURCE)} -- ${shellQuote(JSON.stringify(spec))}`;
}
export function decodeCheckResult(text: string, id: string, outputLimit: number): CheckResult {
	if (text.length > 32768) throw new Error("Invalid oversized watcher check result.");
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error("Watcher check did not return a valid supervised result; registration refused."); }
	const v = value as CheckResult;
	if (!v || v.version !== 1 || v.id !== id || !["result", "failed", "refused", "deadline"].includes(v.kind)
		|| typeof v.output !== "string" || v.output.length > outputLimit || typeof v.omitted !== "boolean" || typeof v.detail !== "string" || v.detail.length > 500
		|| (v.kind === "result" && !Number.isSafeInteger(v.code))
		|| (v.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(v.fingerprint))) throw new Error("Invalid watcher check result; registration refused.");
	return { ...v, output: v.output.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "") };
}
