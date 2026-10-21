import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockPrinter = {
  id: 1,
  name: 'X1C',
  ip_address: '192.168.1.100',
  serial_number: '01P00A000000001',
  access_code: '12345678',
  model: 'X1C',
  enabled: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'stainless_steel',
  location: 'Workshop',
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const STATUS = {
  connected: true,
  state: 'IDLE',
  progress: 0,
  layer_num: 0,
  total_layers: 0,
  temperatures: { nozzle: 25, bed: 25, chamber: 25 },
  remaining_time: 0,
  filename: null,
  wifi_signal: -29,
  speed_level: 2,
  cooling_fan_speed: 0,
  ams: [],
  vt_tray: [],
};

let store: Record<string, string>;

async function renderAt(storage: Record<string, string>) {
  Object.assign(store, storage);
  render(<PrintersPage />);
  await screen.findByTitle('Print');
}

describe('PrintersPage — card sizes', () => {
  beforeEach(() => {
    store = {};
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => store[key] ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      store[key] = String(value);
    });
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json(STATUS)),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
    );
  });

  afterEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
  });

  it('shows badges, temperatures, fans and controls at M', async () => {
    await renderAt({ printerCardSizeV2: '3' });

    await waitFor(() => expect(screen.getByText('-29dBm')).toBeInTheDocument());
    expect(screen.getByText('Controls')).toBeInTheDocument();
    expect(screen.getAllByTitle(/Part Cooling Fan/).length).toBeGreaterThan(0);
  });

  it('hides badges, temperatures, fans and controls at S', async () => {
    await renderAt({ printerCardSizeV2: '2' });

    expect(screen.queryByText('-29dBm')).not.toBeInTheDocument();
    expect(screen.queryByText('Controls')).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Part Cooling Fan/)).not.toBeInTheDocument();
  });

  it('maps a legacy M to the new M rather than the new S', async () => {
    await renderAt({ printerCardSize: '2' });

    expect(screen.getByRole('button', { name: 'M' })).toHaveClass('bg-bambu-green');
  });

  it('maps a legacy S to XS', async () => {
    store.printerCardSize = '1';
    render(<PrintersPage />);

    expect(await screen.findByRole('button', { name: 'XS' })).toHaveClass('bg-bambu-green');
  });
});
