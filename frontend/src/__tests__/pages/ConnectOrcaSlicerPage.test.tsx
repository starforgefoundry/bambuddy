/**
 * OrcaSlicer plugin sign-in approval page.
 *
 * The user must type the code shown in OrcaSlicer: a link can't carry it in,
 * so a request someone else started can't be approved with one click.
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

function renderAt(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/connect${search}`]}>
      <ConnectOrcaSlicerPage />
    </MemoryRouter>,
  );
}

function mockDevice() {
  return vi.spyOn(api, 'getOrcaSlicerDevice').mockResolvedValue({ user_code: USER_CODE, device_name: 'Workshop PC' });
}

async function enterCode(code: string) {
  await userEvent.type(screen.getByRole('textbox', { name: 'Enter the code shown in OrcaSlicer.' }), code);
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectOrcaSlicerPage', () => {
  it('ignores a code in the link and asks for it instead', async () => {
    const get = mockDevice();

    renderAt(`?code=${USER_CODE}`);

    expect(screen.getByRole('textbox', { name: 'Enter the code shown in OrcaSlicer.' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(get).not.toHaveBeenCalled();
  });

  it('lets the user retry a code that matches no request', async () => {
    vi.spyOn(api, 'getOrcaSlicerDevice').mockRejectedValue(new ApiError('Sign-in request not found or expired', 404));

    renderAt();
    await enterCode('wxyz-2345');

    expect(
      await screen.findByText('No sign-in request matches this code. Check it, or start again from OrcaSlicer.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Enter the code shown in OrcaSlicer.' })).toHaveValue('WXYZ-2345');
  });

  it('looks up the typed code, then approves', async () => {
    const get = mockDevice();
    const approve = vi.spyOn(api, 'approveOrcaSlicerDevice').mockResolvedValue({ message: 'Sign-in approved' });

    renderAt();
    await enterCode('abcd-efgh');

    expect(await screen.findByText('Allow OrcaSlicer to connect?')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(USER_CODE);
    expect(screen.getByText('Signed in to Bambuddy as martin')).toBeInTheDocument();
    expect(screen.getByText('Device: Workshop PC')).toBeInTheDocument();
    expect(screen.getByText(USER_CODE)).toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));

    expect(approve).toHaveBeenCalledWith(USER_CODE);
    expect(await screen.findByText('Connected. You can close this tab and return to OrcaSlicer.')).toBeInTheDocument();
  });

  it('deny rejects the request without approving', async () => {
    mockDevice();
    const approve = vi.spyOn(api, 'approveOrcaSlicerDevice');
    const deny = vi.spyOn(api, 'denyOrcaSlicerDevice').mockResolvedValue({ message: 'Sign-in denied' });

    renderAt();
    await enterCode(USER_CODE);
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    expect(deny).toHaveBeenCalledWith(USER_CODE);
    expect(approve).not.toHaveBeenCalled();
    expect(await screen.findByText('Connection denied. You can close this tab.')).toBeInTheDocument();
  });

  it('shows an error when approval fails', async () => {
    mockDevice();
    vi.spyOn(api, 'approveOrcaSlicerDevice').mockRejectedValue(new ApiError('Missing required permissions', 403));

    renderAt();
    await enterCode(USER_CODE);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    expect(await screen.findByText("Can't connect OrcaSlicer")).toBeInTheDocument();
    expect(screen.getByText('Missing required permissions')).toBeInTheDocument();
  });
});
