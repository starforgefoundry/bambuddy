/**
 * Approves a sign-in started by the Bambuddy plugin in OrcaSlicer.
 *
 * The plugin opens this page in the user's browser with `?code=<user code>`
 * and polls the backend until the request is approved or denied here.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle, Link2, Loader2, XCircle } from 'lucide-react';
import { api, ApiError, type OrcaSlicerDevice } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

const HTTP_NOT_FOUND = 404;

type Phase =
  | { kind: 'loading' }
  | { kind: 'consent'; device: OrcaSlicerDevice }
  | { kind: 'connected' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

export function ConnectOrcaSlicerPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const code = searchParams.get('code');
  const [phase, setPhase] = useState<Phase>(() =>
    code ? { kind: 'loading' } : { kind: 'error', message: t('connectedApps.orcaslicer.missingCode') },
  );

  const errorMessage = (err: unknown) => {
    if (err instanceof ApiError && err.status === HTTP_NOT_FOUND) return t('connectedApps.orcaslicer.expired');
    return err instanceof Error ? err.message : t('connectedApps.orcaslicer.failed');
  };

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    api
      .getOrcaSlicerDevice(code)
      .then((device) => {
        if (!cancelled) setPhase({ kind: 'consent', device });
      })
      .catch((err) => {
        if (!cancelled) setPhase({ kind: 'error', message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
    // errorMessage only depends on t, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const decide = async (userCode: string, approve: boolean) => {
    setPhase({ kind: 'loading' });
    try {
      if (approve) {
        await api.approveOrcaSlicerDevice(userCode);
        setPhase({ kind: 'connected' });
      } else {
        await api.denyOrcaSlicerDevice(userCode);
        setPhase({ kind: 'denied' });
      }
    } catch (err) {
      setPhase({ kind: 'error', message: errorMessage(err) });
    }
  };

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
              <p className="text-sm text-bambu-gray">
                {t('connectedApps.orcaslicer.device', { name: phase.device.device_name })}
              </p>
            </div>
            <div className="text-center space-y-2">
              <p className="font-mono text-3xl font-semibold tracking-widest text-white">{phase.device.user_code}</p>
              <p className="text-sm text-bambu-gray">{t('connectedApps.orcaslicer.checkCode')}</p>
            </div>
            <p className="text-sm text-bambu-gray">{t('connectedApps.orcaslicer.permissions')}</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => void decide(phase.device.user_code, false)}
                className="flex-1 px-4 py-2 bg-bambu-dark-tertiary text-white rounded-md hover:bg-bambu-dark-tertiary/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
              >
                {t('connectedApps.orcaslicer.deny')}
              </button>
              <button
                type="button"
                onClick={() => void decide(phase.device.user_code, true)}
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
