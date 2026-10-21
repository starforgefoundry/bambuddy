/**
 * OrcaSlicer plugin sign-in approval page.
 *
 * The page must approve the plugin's request only after the user allows it,
 * and show the code so the user can match it against OrcaSlicer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiError } from '../../api/client';

const mockUseAuth = { authEnabled: true, loading: false, user: { username: 'martin' } };
vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { ConnectOrcaSlicerPage } from '../../pages/ConnectOrcaSlicerPage';

const USER_CODE = 'ABCD-EFGH';

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/connect/orcaslicer${search}`]}>
      <ConnectOrcaSlicerPage />
    </MemoryRouter>,
  );
}

function mockDevice() {
  return vi.spyOn(api, 'getOrcaSlicerDevice').mockResolvedValue({ user_code: USER_CODE, device_name: 'Workshop PC' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectOrcaSlicerPage', () => {
  it('asks the plugin to start sign-in when there is no code', async () => {
    const get = vi.spyOn(api, 'getOrcaSlicerDevice');

    renderAt('');

    expect(await screen.findByText('Start sign-in from the Bambuddy plugin in OrcaSlicer.')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('reports an expired request', async () => {
    vi.spyOn(api, 'getOrcaSlicerDevice').mockRejectedValue(new ApiError('Sign-in request not found or expired', 404));

    renderAt(`?code=${USER_CODE}`);

    expect(await screen.findByText('This sign-in request expired. Start again from OrcaSlicer.')).toBeInTheDocument();
  });

  it('shows the code for consent, then approves', async () => {
    const get = mockDevice();
    const approve = vi.spyOn(api, 'approveOrcaSlicerDevice').mockResolvedValue({ message: 'Sign-in approved' });

    renderAt(`?code=${USER_CODE}`);

    expect(await screen.findByText('Allow OrcaSlicer to connect?')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(USER_CODE);
    expect(screen.getByText('Signed in to Bambuddy as martin')).toBeInTheDocument();
    expect(screen.getByText('Device: Workshop PC')).toBeInTheDocument();
    expect(screen.getByText(USER_CODE)).toBeInTheDocument();
    expect(screen.getByText('Check that this code matches the one shown in OrcaSlicer.')).toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));

    expect(approve).toHaveBeenCalledWith(USER_CODE);
    expect(await screen.findByText('Connected. You can close this tab and return to OrcaSlicer.')).toBeInTheDocument();
  });

  it('deny rejects the request without approving', async () => {
    mockDevice();
    const approve = vi.spyOn(api, 'approveOrcaSlicerDevice');
    const deny = vi.spyOn(api, 'denyOrcaSlicerDevice').mockResolvedValue({ message: 'Sign-in denied' });

    renderAt(`?code=${USER_CODE}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    expect(deny).toHaveBeenCalledWith(USER_CODE);
    expect(approve).not.toHaveBeenCalled();
    expect(await screen.findByText('Connection denied. You can close this tab.')).toBeInTheDocument();
  });

  it('shows an error when approval fails', async () => {
    mockDevice();
    vi.spyOn(api, 'approveOrcaSlicerDevice').mockRejectedValue(new ApiError('Missing required permissions', 403));

    renderAt(`?code=${USER_CODE}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    expect(await screen.findByText("Can't connect OrcaSlicer")).toBeInTheDocument();
    expect(screen.getByText('Missing required permissions')).toBeInTheDocument();
  });
});
