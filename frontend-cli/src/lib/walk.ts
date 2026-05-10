import { promises as fs } from 'fs';
import path from 'path';

export interface MapFile {
    absolutePath: string;
    /** Path relative to the walked root, with platform-native separators. */
    relativePath: string;
}

/** Recursively find every .js.map file under `root`. */
export async function walkForMaps(root: string): Promise<MapFile[]> {
    const out: MapFile[] = [];
    await walk(root, root, out);
    return out;
}

async function walk(root: string, dir: string, out: MapFile[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip node_modules in case someone points --dist at the wrong folder.
            if (entry.name === 'node_modules') continue;
            await walk(root, full, out);
        } else if (entry.isFile() && entry.name.endsWith('.js.map')) {
            out.push({
                absolutePath: full,
                relativePath: path.relative(root, full),
            });
        }
    }
}
