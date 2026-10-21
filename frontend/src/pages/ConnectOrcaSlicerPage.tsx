/**
 * Approves a sign-in started by the Bambuddy plugin in OrcaSlicer.
 *
 * The plugin opens this page in the user's browser and shows a code in
 * OrcaSlicer. The user types that code here, then approves or denies, while
 * the plugin polls the backend for the outcome.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, Link2, Loader2, XCircle } from 'lucide-react';
import { api, ApiError, type OrcaSlicerDevice } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

const HTTP_NOT_FOUND = 404;
const USER_CODE_INPUT_MAX_LENGTH = 9;
const USER_CODE_PLACEHOLDER = 'XXXX-XXXX';

type Phase =
  | { kind: 'enter'; error?: string }
  | { kind: 'loading' }
  | { kind: 'consent'; device: OrcaSlicerDevice }
  | { kind: 'connected' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

export function ConnectOrcaSlicerPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [typedCode, setTypedCode] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'enter' });

  const errorMessage = (err: unknown) => {
    if (err instanceof ApiError && err.status === HTTP_NOT_FOUND) return t('connectedApps.orcaslicer.expired');
    return err instanceof Error ? err.message : t('connectedApps.orcaslicer.failed');
  };

  const lookUp = async (event: FormEvent) => {
    event.preventDefault();
    const code = typedCode.trim();
    if (!code) return;
    setPhase({ kind: 'loading' });
    try {
      setPhase({ kind: 'consent', device: await api.getOrcaSlicerDevice(code) });
    } catch (err) {
      const notFound = err instanceof ApiError && err.status === HTTP_NOT_FOUND;
      setPhase({ kind: 'enter', error: notFound ? t('connectedApps.orcaslicer.codeNotFound') : errorMessage(err) });
    }
  };

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
        {phase.kind === 'enter' && (
          <form className="space-y-4" onSubmit={(event) => void lookUp(event)}>
            <div className="text-center space-y-3">
              <div className="w-14 h-14 mx-auto rounded-full bg-bambu-green/20 flex items-center justify-center">
                <Link2 className="w-7 h-7 text-bambu-green" />
              </div>
              <h1 className="text-xl font-semibold text-white text-balance">
                {t('connectedApps.orcaslicer.enterTitle')}
              </h1>
              <p className="text-sm text-bambu-gray">
                {t('connectedApps.authorize.signedInAs', { username: user?.username ?? '' })}
              </p>
            </div>
            <label className="block space-y-2">
              <span className="block text-sm text-bambu-gray">{t('connectedApps.orcaslicer.enterCode')}</span>
              <input
                type="text"
                value={typedCode}
                onChange={(event) => setTypedCode(event.target.value.toUpperCase())}
                maxLength={USER_CODE_INPUT_MAX_LENGTH}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                autoFocus
                placeholder={USER_CODE_PLACEHOLDER}
                className="w-full px-4 py-2 font-mono text-2xl text-center tracking-widest bg-bambu-dark border border-bambu-dark-tertiary rounded-md text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
              />
            </label>
            {phase.error && (
              <p className="text-sm text-yellow-600 dark:text-yellow-400" role="alert">
                {phase.error}
              </p>
            )}
            <button
              type="submit"
              disabled={!typedCode.trim()}
              className="w-full px-4 py-2 bg-bambu-green text-white rounded-md hover:bg-bambu-green/90 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              {t('connectedApps.orcaslicer.continue')}
            </button>
          </form>
        )}

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
            <p className="text-center font-mono text-3xl font-semibold tracking-widest text-white">
              {phase.device.user_code}
            </p>
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
