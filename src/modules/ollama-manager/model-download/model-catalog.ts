// ─── Model Catalog ─────────────────────────────────────────────────────────────
// Curated registry of Ollama models with size, RAM requirements, and device
// compatibility flags. All sizes are in MB. No paid APIs — Ollama only.
// ────────────────────────────────────────────────────────────────────────────────

export interface CatalogModel {
    /** Ollama model tag, e.g. "gemma2:2b" */
    name: string;
    /** Human-readable label */
    label: string;
    /** Download size in MB */
    sizeMb: number;
    /** Minimum device RAM (MB) required to run this model */
    minRamMb: number;
    /** If device RAM exceeds this, prefer a larger model instead */
    maxRamMb: number;
    /** Quality ranking (higher = better output quality) */
    qualityScore: number;
    /** Compatible device types */
    devices: ('ANDROID' | 'DESKTOP' | 'TABLET')[];
    /** Brief description */
    description: string;
}

/**
 * Static curated model catalog.
 * Ordered by sizeMb ascending for efficient filtering.
 */
export const MODEL_CATALOG: CatalogModel[] = [
    {
        name: 'tinyllama:1.1b',
        label: 'TinyLlama 1.1B',
        sizeMb: 640,
        minRamMb: 1024,
        maxRamMb: 2048,
        qualityScore: 40,
        devices: ['ANDROID', 'TABLET'],
        description: 'Ultra-light model for low-end Android devices.',
    },
    {
        name: 'qwen2.5:0.5b',
        label: 'Qwen 2.5 0.5B',
        sizeMb: 400,
        minRamMb: 1024,
        maxRamMb: 2048,
        qualityScore: 35,
        devices: ['ANDROID', 'TABLET'],
        description: 'Smallest Qwen model, ideal for constrained devices.',
    },
    {
        name: 'qwen2.5:1.5b',
        label: 'Qwen 2.5 1.5B',
        sizeMb: 950,
        minRamMb: 2048,
        maxRamMb: 4096,
        qualityScore: 55,
        devices: ['ANDROID', 'TABLET', 'DESKTOP'],
        description: 'Good balance of size and quality for mobile.',
    },
    {
        name: 'gemma2:2b',
        label: 'Gemma 2 2B',
        sizeMb: 1600,
        minRamMb: 3072,
        maxRamMb: 6144,
        qualityScore: 65,
        devices: ['ANDROID', 'TABLET', 'DESKTOP'],
        description: 'Google Gemma 2B — strong quality within 2GB limit.',
    },
    {
        name: 'phi3:mini',
        label: 'Phi-3 Mini',
        sizeMb: 2300,
        minRamMb: 4096,
        maxRamMb: 8192,
        qualityScore: 75,
        devices: ['TABLET', 'DESKTOP'],
        description: 'Microsoft Phi-3 Mini — great for desktop with 4GB+ RAM.',
    },
    {
        name: 'llama3.2:3b',
        label: 'Llama 3.2 3B',
        sizeMb: 2000,
        minRamMb: 4096,
        maxRamMb: 8192,
        qualityScore: 78,
        devices: ['TABLET', 'DESKTOP'],
        description: 'Meta Llama 3.2 3B — high quality, desktop-class.',
    },
    {
        name: 'llama3.2:8b',
        label: 'Llama 3.2 8B',
        sizeMb: 4700,
        minRamMb: 8192,
        maxRamMb: 16384,
        qualityScore: 88,
        devices: ['DESKTOP'],
        description: 'Llama 3.2 8B — excellent quality for 8GB+ RAM desktops.',
    },
    {
        name: 'gemma2:9b',
        label: 'Gemma 2 9B',
        sizeMb: 5400,
        minRamMb: 8192,
        maxRamMb: 32768,
        qualityScore: 90,
        devices: ['DESKTOP'],
        description: 'Gemma 2 9B — top-tier quality for high-RAM desktops.',
    },
    {
        name: 'qwen2.5:7b',
        label: 'Qwen 2.5 7B',
        sizeMb: 4400,
        minRamMb: 8192,
        maxRamMb: 16384,
        qualityScore: 85,
        devices: ['DESKTOP'],
        description: 'Qwen 2.5 7B — excellent multilingual desktop model.',
    },
    {
        name: 'llama3.1:70b',
        label: 'Llama 3.1 70B',
        sizeMb: 40000,
        minRamMb: 65536,
        maxRamMb: 131072,
        qualityScore: 98,
        devices: ['DESKTOP'],
        description: 'Llama 3.1 70B — server-grade, requires 64GB+ RAM.',
    },
];

/**
 * Android hard cap: models must be ≤ 2GB download size.
 */
export const ANDROID_MODEL_SIZE_LIMIT_MB = 2048;

/**
 * Default model per device type (fallback if recommendation fails).
 */
export const DEFAULT_MODELS: Record<string, string> = {
    ANDROID: 'qwen2.5:1.5b',
    TABLET: 'gemma2:2b',
    DESKTOP: 'phi3:mini',
    UNKNOWN: 'qwen2.5:1.5b',
};
