// Injected by OrcaSlicer into every top-level page of its plugin webviews.
interface OrcaBridge {
  postMessage: (data: unknown) => void;
  submit: (data: unknown) => void;
  close: () => void;
  onMessage: (callback: (data: unknown) => void) => void;
}

interface Window {
  orca?: OrcaBridge;
}
