import { promises as fs } from 'fs';
import path from 'path';

export interface UploadInput {
    api:                 string;
    token:               string;
    masterProjectId:     string;
    frontendProjectUuid: string;
    release:             string;
    environment:         string;
    assetUrl:            string;
    mapPath:             string;
}

/** POST one .js.map to the backend. Throws on non-2xx. */
export async function uploadSourcemap(input: UploadInput): Promise<void> {
    const buffer = await fs.readFile(input.mapPath);
    const blob   = new Blob([buffer], { type: 'application/json' });

    const form = new FormData();
    form.append('release',     input.release);
    form.append('environment', input.environment);
    form.append('asset_url',   input.assetUrl);
    form.append('sourcemap',   blob, path.basename(input.mapPath));

    const url =
        `${input.api.replace(/\/+$/, '')}` +
        `/v1/projects/${input.masterProjectId}` +
        `/frontend-projects/${input.frontendProjectUuid}` +
        `/sourcemaps`;

    const res = await fetch(url, {
        method:  'POST',
        headers: { Authorization: `Bearer ${input.token}` },
        body:    form,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();
        throw new Error(`HTTP ${res.status}${snippet ? ` — ${snippet}` : ''}`);
    }
}
