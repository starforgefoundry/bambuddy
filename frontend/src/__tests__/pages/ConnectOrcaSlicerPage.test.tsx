/**
 * OrcaSlicer plugin connect page.
 *
 * The page must hand a key to the plugin only after consent (or when there is
 * no authentication to consent to), and only through `window.orca`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiError } from '../../api/client';

const mockUseAuth = { authEnabled: true, loading: false, user: { username: 'martin' } };
vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { ConnectOrcaSlicerPage } from '../../pages/ConnectOrcaSlicerPage';

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/connect/orcaslicer${search}`]}>
      <ConnectOrcaSlicerPage />
    </MemoryRouter>,
  );
}

let postMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockUseAuth.authEnabled = true;
  postMessage = vi.fn();
  window.orca = { postMessage, submit: vi.fn(), close: vi.fn(), onMessage: vi.fn() };
});

afterEach(() => {
  delete window.orca;
  vi.restoreAllMocks();
});

describe('ConnectOrcaSlicerPage', () => {
  it('asks for consent, then posts the new key to the plugin', async () => {
    const create = vi
      .spyOn(api, 'createOrcaSlicerToken')
      .mockResolvedValue({ key: 'bb_k3y', username: 'martin', auth_enabled: true });

    renderAt('?device=Workshop%20PC');

    expect(await screen.findByText('Allow OrcaSlicer to connect?')).toBeInTheDocument();
    expect(screen.getByText('Signed in to Bambuddy as martin')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));

    expect(create).toHaveBeenCalledWith('Workshop PC');
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: 'bambuddy-token',
        key: 'bb_k3y',
        username: 'martin',
        authEnabled: true,
      }),
    );
    expect(await screen.findByText('Connected. You can close this window.')).toBeInTheDocument();
  });

  it('names the key after OrcaSlicer when the plugin sends no device', async () => {
    const create = vi
      .spyOn(api, 'createOrcaSlicerToken')
      .mockResolvedValue({ key: 'bb_k3y', username: 'martin', auth_enabled: true });

    renderAt('');
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    expect(create).toHaveBeenCalledWith('OrcaSlicer');
  });

  it('deny tells the plugin and creates no key', async () => {
    const create = vi.spyOn(api, 'createOrcaSlicerToken');

    renderAt('?device=x');
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    expect(postMessage).toHaveBeenCalledWith({ type: 'bambuddy-token-denied' });
    expect(create).not.toHaveBeenCalled();
  });

  it('skips consent while authentication is off', async () => {
    mockUseAuth.authEnabled = false;
    vi.spyOn(api, 'createOrcaSlicerToken').mockResolvedValue({ key: null, username: null, auth_enabled: false });

    renderAt('?device=x');

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: 'bambuddy-token',
        key: null,
        username: null,
        authEnabled: false,
      }),
    );
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('shows an error and posts nothing when the key cannot be created', async () => {
    vi.spyOn(api, 'createOrcaSlicerToken').mockRejectedValue(new ApiError('Missing required permissions', 403));

    renderAt('?device=x');
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    expect(await screen.findByText("Can't connect OrcaSlicer")).toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('refuses to run outside the OrcaSlicer plugin', async () => {
    delete window.orca;
    const create = vi.spyOn(api, 'createOrcaSlicerToken');

    renderAt('?device=x');

    expect(await screen.findByText('Open this page from the Bambuddy plugin in OrcaSlicer.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});
