// Setup: checks that this computer has what Autodos needs, and fixes what it can with one click.
import { ReactNode, useState } from 'react';
import { actions, CheckId, Doctor, DoctorItem, Feishu, useDoctor } from './api';
import { useT } from './i18n';
import { Icon } from './icons';
import { Group } from './ui';

const NAMES: Record<CheckId, string> = { node: 'Node.js', git: 'Git', claude: 'Claude Code', codex: 'Codex', gh: 'GitHub CLI' };

export function checkState(x: DoctorItem): 'ok' | 'login' | 'missing' | 'old' {
  if (x.ok) return 'ok';
  if (x.problem === 'old') return 'old';
  return x.installed ? 'login' : 'missing';
}

/** Small status mark used here and on the Machines tab. */
export function CheckMark({ item }: { item: DoctorItem }) {
  const s = checkState(item);
  return <span className={`check-mark ${s === 'ok' ? 'ok' : item.need === 'optional' ? 'off' : 'warn'}`}>{s === 'ok' && <Icon name="check" size={11} />}</span>;
}

function CheckRow({ item, job, onFix, note: given }: { item: DoctorItem; job?: Doctor['jobs'][string]; onFix: () => void; note?: ReactNode }) {
  const t = useT();
  let note = given;
  const [showLog, setShowLog] = useState(false);
  const s = checkState(item);
  const detail =
    s === 'ok'
      ? [item.version, item.account].filter(Boolean).join(' · ')
      : s === 'old'
        ? `${item.version} · ${t.chkTooOld}`
        : s === 'login'
          ? `${item.version ? item.version + ' · ' : ''}${t.chkSignedOut}`
          : t.chkMissing;
  const running = !!job?.running;
  const failed = job && !job.running && job.ok === false;
  // A newer Node only takes effect once Autodos starts again on it.
  if (item.id === 'node' && s === 'old' && job && !job.running && job.ok) note = t.chkRestart;
  return (
    <div className="g-row stack check-row">
      <div className="check-line">
        <CheckMark item={item} />
        <span className="check-name">{NAMES[item.id]}</span>
        <span className={`check-detail ${s === 'ok' || item.need === 'optional' ? '' : 'warn-text'}`}>{running ? t.chkInstalling : detail}</span>
        <span className="grow" />
        {item.fix && (
          <button className={`btn small ${item.need === 'optional' ? 'ghost' : ''}`} disabled={running} onClick={onFix}>
            {running ? t.chkInstalling : item.fix === 'login' ? t.chkSignIn : s === 'old' ? t.chkUpdate : t.chkInstall}
          </button>
        )}
      </div>
      {(note || failed) && (
        <div className="check-note">
          {failed ? (
            <>
              <span className="error-line">{t.chkFailed}</span>{' '}
              <button className="link-btn" onClick={() => setShowLog((v) => !v)}>
                {showLog ? t.chkHideOutput : t.chkShowOutput}
              </button>
            </>
          ) : (
            note
          )}
        </div>
      )}
      {failed && showLog && <pre className="check-log">{`$ ${job!.command}\n${job!.log}`}</pre>}
    </div>
  );
}

export function SetupSection({ feishu }: { feishu?: Feishu }) {
  const t = useT();
  const [watching, setWatching] = useState(false);
  const { doctor, checking, check, refresh } = useDoctor(watching);
  const [notes, setNotes] = useState<Partial<Record<CheckId, ReactNode>>>({});
  const [error, setError] = useState('');

  const fix = async (item: DoctorItem) => {
    setError('');
    try {
      const r = await actions.fixCheck(item.id);
      const note: ReactNode =
        r.kind === 'terminal' ? (
          t.chkTerminalOpened
        ) : r.kind === 'manual' ? (
          <>
            {t.chkRunThis} <code>{r.command}</code>
          </>
        ) : r.kind === 'link' ? (
          <a href={r.url} target="_blank" rel="noreferrer">
            {t.chkDownload} {new URL(r.url).host}
          </a>
        ) : null;
      setNotes((n) => ({ ...n, [item.id]: note }));
      // Signing in happens elsewhere; keep checking for a few minutes so the row turns green by itself.
      if (r.kind !== 'none') {
        setWatching(true);
        setTimeout(() => setWatching(false), 4 * 60_000);
      }
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (!doctor) return <div className="muted">{t.chkChecking}</div>;
  const by = (need: DoctorItem['need']) => doctor.items.filter((x) => x.need === need);
  const missing = doctor.items.filter((x) => !x.ok && x.need === 'required').length + (doctor.agent ? 0 : 1);
  const row = (x: DoctorItem) => <CheckRow key={x.id} item={x} job={doctor.jobs[x.id]} note={x.ok ? undefined : notes[x.id]} onFix={() => fix(x)} />;

  return (
    <>
      <div className={`setup-status ${doctor.ready ? 'ok' : 'warn'}`} role="status">
        <span className={`check-mark big ${doctor.ready ? 'ok' : 'warn'}`}>{doctor.ready && <Icon name="check" size={14} />}</span>
        <strong>{doctor.ready ? t.chkReady : t.chkNotReady.replace('{n}', String(missing))}</strong>
        <span className="grow" />
        <button className="btn ghost small" onClick={check} disabled={checking}>
          <Icon name="retry" size={13} /> {checking ? t.chkChecking : t.chkAgain}
        </button>
      </div>
      {error && <div className="error-line">{error}</div>}
      <Group title={t.chkBasics}>{by('required').map(row)}</Group>
      <Group title={t.chkAgents}>{by('agent').map(row)}</Group>
      <Group title={t.chkOptional}>{by('optional').map(row)}</Group>
      {feishu && (
        <Group title={t.sec_feishu}>
          <div className="g-row stack check-row">
            <div className="check-line">
              <span className={`check-mark ${feishu.bound && feishu.status === 'on' ? 'ok' : 'off'}`}>{feishu.bound && feishu.status === 'on' && <Icon name="check" size={11} />}</span>
              <span className="check-name">{t.fsSetupRow}</span>
              <span className="check-detail">{feishu.bound ? (feishu.status === 'on' ? feishu.chatName || t.fsOn : t.fsError) : ''}</span>
              <span className="grow" />
              <a className="btn small" href="#/settings/feishu">
                {feishu.bound ? t.settings : t.fsBind}
              </a>
            </div>
          </div>
        </Group>
      )}
    </>
  );
}
