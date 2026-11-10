// Feishu: bind a bot by scanning a QR code, then see whether it is connected and where it lives.
import qrcode from 'qrcode-generator';
import { useMemo, useState } from 'react';
import { actions, State } from './api';
import { useT } from './i18n';
import { Icon } from './icons';
import { useError } from './pages';
import { Group, Row } from './ui';

function QR({ text, size = 232 }: { text: string; size?: number }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'L'); // lowest error correction: fewer, larger squares for a long link
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [text]);
  return <div className="qr" style={{ width: size, height: size }} role="img" aria-label="QR code" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function FeishuSection({ state }: { state: State }) {
  const t = useT();
  const f = state.feishu;
  const { error, guard } = useError();
  const [msg, setMsg] = useState('');
  const [starting, setStarting] = useState(false);

  // A scan in progress: the first binding, or a re-scan that adds permissions to the bound app.
  const scanning = f.pending && (
    <div className="bind-card">
      <QR text={f.pending.url} />
      <div className="bind-text">
        <strong>{t.fsScan}</strong>
        <p className="muted">{f.bound ? t.fsReauthHow : t.fsScanHow}</p>
        <div className="inline-row">
          <a className="btn ghost small" href={f.pending.url} target="_blank" rel="noreferrer">
            {t.fsOpenLink}
          </a>
          <button className="btn ghost small" onClick={guard(() => actions.feishuCancel())}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );

  if (!f.bound) {
    return (
      <>
        <div className="bind-card">
          {f.pending ? (
            <>
              <QR text={f.pending.url} />
              <div className="bind-text">
                <strong>{t.fsScan}</strong>
                <p className="muted">{t.fsScanHow}</p>
                <div className="inline-row">
                  <a className="btn ghost small" href={f.pending.url} target="_blank" rel="noreferrer">
                    {t.fsOpenLink}
                  </a>
                  <button className="btn ghost small" onClick={guard(() => actions.feishuCancel())}>
                    {t.cancel}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <span className="bind-mark">
                <Icon name="chat" size={22} />
              </span>
              <div className="bind-text">
                <strong>{t.fsBindTitle}</strong>
                <p className="muted">{t.fsBindWhat}</p>
                <button
                  className="btn primary"
                  disabled={starting}
                  onClick={guard(async () => {
                    setStarting(true);
                    try {
                      await actions.feishuBind();
                    } finally {
                      setStarting(false);
                    }
                  })}
                >
                  {starting ? t.chkChecking : t.fsBind}
                </button>
              </div>
            </>
          )}
        </div>
        {(error || f.error) && <div className="error-line">{error || f.error}</div>}
      </>
    );
  }

  const status = { on: t.fsOn, connecting: t.fsConnecting, error: t.fsError, off: t.fsOff }[f.status];
  return (
    <>
      {scanning}
      <Group>
        <Row label={t.fsStatus}>
          <span className="inline-row">
            <span className={`dot-live ${f.status === 'on' ? 'run' : f.status === 'connecting' ? 'wait' : 'off'}`} />
            {status}
          </span>
        </Row>
        {f.error && (
          <div className="g-row stack">
            <span className="error-line">{f.error}</span>
          </div>
        )}
        <Row label={t.fsBot} sub={f.appId}>
          <span>{f.botName || 'Autodos'}</span>
        </Row>
        <Row label={t.fsGroup} sub={f.chatName ? undefined : t.fsNoGroup}>
          <span>{f.chatName || '—'}</span>
        </Row>
      </Group>
      <div className="inline-row wrap">
        <button className="btn" disabled={f.status !== 'on'} onClick={guard(async () => (await actions.feishuTest(), setMsg(t.sent)))}>
          {t.fsTest}
        </button>
        <button className="btn ghost" onClick={guard(async () => (setMsg(''), await actions.feishuReconnect()))}>
          {t.fsReconnect}
        </button>
        <button className="btn ghost" disabled={!!f.pending} onClick={guard(async () => (setMsg(''), await actions.feishuBind()))}>
          {t.fsReauth}
        </button>
        <span className="grow" />
        <button className="btn ghost danger" onClick={guard(async () => confirm(t.fsUnbindAsk) && (await actions.feishuUnbind()))}>
          {t.fsUnbind}
        </button>
      </div>
      {(error || msg) && (
        <div className={error ? 'error-line' : 'muted small'} role="status">
          {error || msg}
        </div>
      )}
    </>
  );
}
