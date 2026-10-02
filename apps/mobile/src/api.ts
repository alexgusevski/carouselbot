import type { Project, Account, Job } from './types';
import { Platform } from 'react-native';

export class ApiError extends Error {
  code: string;
  project?: Project;
  constructor(body: any) {
    super(body.error || 'Unable to connect. Please retry.');
    this.code = body.code;
    this.project = body.project;
  }
}
export const apiUrl = (
  process.env.EXPO_PUBLIC_API_URL ||
  'https://carouselbot-product-dev.longformstudio-api.workers.dev'
).replace(/\/$/, '');
export class MobileApi {
  constructor(private getToken: () => Promise<string | null>) {}
  private async headers() {
    const token = await this.getToken();
    if (!token) throw new Error('Sign in to continue.');
    return { authorization: `Bearer ${token}`, 'x-carousel-client': 'mobile' };
  }
  async request<T = any>(path: string, method = 'GET', body?: any): Promise<T> {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        ...(await this.headers()),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data);
    return data;
  }
  async list(): Promise<Project[]> {
    return (await this.request('/api/projects')).projects;
  }
  async load(id: string): Promise<Project> {
    return (await this.request(`/api/projects/${id}`)).project;
  }
  async save(project: Project, revision: number): Promise<Project> {
    return (
      await this.request(`/api/projects/${project.id}`, 'PUT', {
        project,
        expectedRevision: revision,
      })
    ).project;
  }
  async account(): Promise<Account> {
    return this.request('/api/account');
  }
  async upload(uri: string, name: string, mimeType: string) {
    const bytes =
      Platform.OS === 'web'
        ? new Uint8Array(await (await fetch(uri)).arrayBuffer())
        : await new (require('expo-file-system').File)(uri).bytes();
    const response = await fetch(`${apiUrl}/api/assets`, {
      method: 'POST',
      headers: {
        ...(await this.headers()),
        'content-type': mimeType,
        'x-file-name': encodeURIComponent(name),
      },
      body: bytes as any,
      signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok) throw new ApiError(result);
    return result;
  }
  private mediaCache = new Map<string, string>();
  clearMedia() {
    this.mediaCache.clear();
  }
  async media(source: string): Promise<string> {
    if (!source?.startsWith('/api/assets/')) return source;
    const cached = this.mediaCache.get(source);
    if (cached) return cached;
    const response = await fetch(`${apiUrl}${source}`, {
      headers: await this.headers(),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Unable to load this project’s media.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    // File.base64 avoids large String.fromCharCode argument lists on Hermes.
    let data: string;
    if (Platform.OS === 'web')
      data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(
          new Blob([bytes], {
            type: response.headers.get('content-type') || 'application/octet-stream',
          }),
        );
      });
    else {
      const { File, Paths } = require('expo-file-system');
      const file = new File(
        Paths.cache,
        `carousel-media-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      try {
        file.create();
        file.write(bytes);
        data = `data:${response.headers.get('content-type')};base64,${await file.base64()}`;
      } finally {
        if (file.exists) file.delete();
      }
    }
    while (
      [...this.mediaCache.values()].reduce((n, value) => n + value.length, 0) + data.length >
        32_000_000 &&
      this.mediaCache.size
    )
      this.mediaCache.delete(this.mediaCache.keys().next().value!);
    this.mediaCache.set(source, data);
    return data;
  }
  async hydrate(project: Project, slideId: string): Promise<Project> {
    const slide = project.slides.find((s) => s.id === slideId);
    if (!slide) return project;
    const ids = new Set((slide.overlays || []).map((layer) => layer.assetId));
    const sources = [
      slide,
      ...project.assets.filter((asset) => ids.has(asset.id)),
      ...(project.fonts || []),
    ];
    const replacements = new Map<string, string>();
    for (const item of sources)
      for (const key of ['imageData', 'videoData', 'fontData'])
        if (item[key]?.startsWith('/api/assets/'))
          replacements.set(item[key], await this.media(item[key]));
    const replace = (item: any) =>
      Object.fromEntries(
        Object.entries(item).map(([key, value]) => [
          key,
          typeof value === 'string' && replacements.has(value) ? replacements.get(value) : value,
        ]),
      );
    return {
      ...project,
      slides: [replace(slide)] as any,
      assets: project.assets.filter((asset) => ids.has(asset.id)).map(replace) as any,
      fonts: project.fonts?.map(replace),
    };
  }
  async startJob(
    project: Project,
    prompt: string,
    requestId: string,
    attachmentIds: string[],
  ): Promise<Job> {
    return (
      await this.request(`/api/projects/${project.id}/jobs`, 'POST', {
        prompt,
        expectedRevision: project.revision,
        requestId,
        attachmentIds,
      })
    ).job;
  }
}
