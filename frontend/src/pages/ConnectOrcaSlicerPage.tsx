/**
 * Connects the Bambuddy plugin in OrcaSlicer.
 *
 * The plugin opens this page in its webview. After the user signs in and
 * approves, the page creates an API key for the plugin and hands it over
 * through `window.orca.postMessage`, which OrcaSlicer injects into the page.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle, Link2, Loader2, XCircle } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

const DEFAULT_DEVICE_NAME = 'OrcaSlicer';
const TOKEN_MESSAGE = 'bambuddy-token';
const DENIED_MESSAGE = 'bambuddy-token-denied';

type Phase =
  | { kind: 'loading' }
  | { kind: 'consent' }
  | { kind: 'connected' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

export function ConnectOrcaSlicerPage() {
  const { t } = useTranslation();
  const { authEnabled, loading, user } = useAuth();
  const [searchParams] = useSearchParams();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const started = useRef(false);

  const deviceName = searchParams.get('device') || DEFAULT_DEVICE_NAME;

  const approve = async () => {
    setPhase({ kind: 'loading' });
    try {
      const result = await api.createOrcaSlicerToken(deviceName);
      window.orca?.postMessage({
        type: TOKEN_MESSAGE,
        key: result.key,
        username: result.username,
        authEnabled: result.auth_enabled,
      });
      setPhase({ kind: 'connected' });
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : t('connectedApps.orcaslicer.failed'),
      });
    }
  };

  const deny = () => {
    window.orca?.postMessage({ type: DENIED_MESSAGE });
    setPhase({ kind: 'denied' });
  };

  useEffect(() => {
    if (loading || started.current) return;
    started.current = true;

    if (!window.orca) {
      setPhase({ kind: 'error', message: t('connectedApps.orcaslicer.notInPlugin') });
      return;
    }
    if (!authEnabled) {
      void approve();
      return;
    }
    setPhase({ kind: 'consent' });
    // approve() reads the same query parameters; running this once is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, authEnabled]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bambu-dark p-4">
      <div className="max-w-md w-full space-y-6 p-8 bg-gradient-to-br from-bambu-card to-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary shadow-lg">
        {phase.kind === 'loading' && (
          <div className="flex flex-col items-center gap-3 text-bambu-gray" role="status">
            <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
            <p>{t('connectedApps.orcaslicer.connecting')}</p>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="text-center space-y-3">
            <AlertTriangle className="w-10 h-10 mx-auto text-yellow-600 dark:text-yellow-400" />
            <h1 className="text-xl font-semibold text-white">{t('connectedApps.orcaslicer.errorTitle')}</h1>
            <p className="text-sm text-bambu-gray">{phase.message}</p>
          </div>
        )}

        {phase.kind === 'connected' && (
          <div className="text-center space-y-3" role="status">
            <CheckCircle className="w-10 h-10 mx-auto text-bambu-green" />
            <p className="text-white">{t('connectedApps.orcaslicer.connected')}</p>
          </div>
        )}

        {phase.kind === 'denied' && (
          <div className="text-center space-y-3" role="status">
            <XCircle className="w-10 h-10 mx-auto text-bambu-gray" />
            <p className="text-white">{t('connectedApps.orcaslicer.denied')}</p>
          </div>
        )}

        {phase.kind === 'consent' && (
          <>
            <div className="text-center space-y-3">
              <div className="w-14 h-14 mx-auto rounded-full bg-bambu-green/20 flex items-center justify-center">
                <Link2 className="w-7 h-7 text-bambu-green" />
              </div>
              <h1 className="text-xl font-semibold text-white text-balance">
                {t('connectedApps.orcaslicer.title')}
              </h1>
              <p className="text-sm text-bambu-gray">
                {t('connectedApps.authorize.signedInAs', { username: user?.username ?? '' })}
              </p>
            </div>
            <p className="text-sm text-bambu-gray">{t('connectedApps.orcaslicer.permissions')}</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={deny}
                className="flex-1 px-4 py-2 bg-bambu-dark-tertiary text-white rounded-md hover:bg-bambu-dark-tertiary/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
              >
                {t('connectedApps.orcaslicer.deny')}
              </button>
              <button
                type="button"
                onClick={() => void approve()}
                className="flex-1 px-4 py-2 bg-bambu-green text-white rounded-md hover:bg-bambu-green/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                {t('connectedApps.authorize.allow')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
