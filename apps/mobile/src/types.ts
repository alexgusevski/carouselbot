export type Layer = {
  id: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  rotation?: number;
  z?: number;
  opacity?: number;
  text?: string;
  size?: number;
  style?: string;
  color?: string;
  background?: string;
  backgroundShape?: string;
  align?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontId?: string;
  assetId?: string;
  crop?: { x: number; y: number; w: number; h: number };
  [key: string]: any;
};
export type Asset = {
  id: string;
  name: string;
  width: number;
  height: number;
  imageData?: string;
  videoData?: string;
  duration?: number;
  [key: string]: any;
};
export type Slide = Asset & {
  texts: Layer[];
  overlays: Layer[];
  backgroundColor?: string;
  imageScale?: number;
  imageX?: number;
  imageY?: number;
};
export type Project = {
  id: string;
  name: string;
  revision: number;
  slides: Slide[];
  assets: Asset[];
  fonts?: any[];
  updatedAt: number;
  folderPath?: string;
  [key: string]: any;
};
export type Account = {
  userId: string;
  credits: number;
  canGenerate: boolean;
  billing: {
    active: boolean;
    provider: 'polar' | 'revenuecat' | null;
    store: string | null;
    periodEnd: number | null;
  };
};
export type Job = {
  id: string;
  projectId: string;
  status: 'queued' | 'running' | 'completed' | 'stopped' | 'failed';
  error?: string;
  canUndo?: boolean;
};
export type Selection = { kind: 'text' | 'overlay'; id: string } | null;
