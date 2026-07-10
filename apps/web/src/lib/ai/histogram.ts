/**
 * Histogram computation and scene boundary detection.
 *
 * Uses Histogram Intersection Distance and Two-Pass detection:
 * - Coarse Pass: finds candidate regions from sparse I-Frame samples
 * - Fine Pass: finds exact cut point from frame-by-frame data in narrow region
 */

import type { CandidateRegion, FrameStats, SceneBoundary } from "./types";

// ─── RGB Histogram Computation ──────────────────────────────

const BINS_PER_CHANNEL = 16;
const TOTAL_BINS = 3 * BINS_PER_CHANNEL; // 48

/**
 * Compute a 48-bin RGB histogram from ImageData (64×64 RGBA).
 * 3 channels (R, G, B) × 16 bins each.
 * Values are normalized (sum to 1 per channel).
 */
export function computeRGBHistogram(imageData: ImageData): number[] {
	const data = imageData.data;
	const histogram = new Float64Array(TOTAL_BINS);
	const pixelCount = data.length / 4;

	for (let i = 0; i < data.length; i += 4) {
		const rBin = Math.min(Math.floor(data[i] / 16), BINS_PER_CHANNEL - 1);
		const gBin = Math.min(
			Math.floor(data[i + 1] / 16),
			BINS_PER_CHANNEL - 1,
		);
		const bBin = Math.min(
			Math.floor(data[i + 2] / 16),
			BINS_PER_CHANNEL - 1,
		);

		histogram[rBin]++;
		histogram[BINS_PER_CHANNEL + gBin]++;
		histogram[2 * BINS_PER_CHANNEL + bBin]++;
	}

	// Normalize per channel
	for (let ch = 0; ch < 3; ch++) {
		const offset = ch * BINS_PER_CHANNEL;
		for (let b = 0; b < BINS_PER_CHANNEL; b++) {
			histogram[offset + b] /= pixelCount;
		}
	}

	return Array.from(histogram);
}

// ─── Histogram Intersection Distance ────────────────────────

/**
 * Histogram Intersection Distance.
 * D(H1, H2) = 1 - Σ min(H1(i), H2(i)) / Σ H1(i)
 *
 * Returns 0 if histograms are identical, 1 if completely different.
 */
export function histogramDistance(h1: number[], h2: number[]): number {
	let sumMin = 0;
	let sumH1 = 0;
	for (let i = 0; i < h1.length; i++) {
		sumMin += Math.min(h1[i], h2[i]);
		sumH1 += h1[i];
	}
	return sumH1 > 0 ? 1 - sumMin / sumH1 : 0;
}

// ─── Two-Pass Scene Detection ───────────────────────────────

/**
 * COARSE PASS: Find candidate regions where scene cuts likely occurred.
 *
 * Input: sparse frame stats from I-Frame sampling (1-3s intervals).
 * Output: narrow time regions to refine with Fine Pass.
 *
 * If delta between two consecutive frames exceeds threshold,
 * the region [frameA.timestamp, frameB.timestamp] is a candidate.
 */
export function findCandidateRegions(
	frames: FrameStats[],
	threshold = 0.75,
): CandidateRegion[] {
	const regions: CandidateRegion[] = [];

	for (let i = 1; i < frames.length; i++) {
		const d = histogramDistance(
			frames[i - 1].rgbHistogram,
			frames[i].rgbHistogram,
		);

		if (d > threshold) {
			regions.push({
				start: frames[i - 1].timestamp,
				end: frames[i].timestamp,
			});
		}
	}

	return regions;
}

/**
 * FINE PASS: Find exact Hard Cut timestamp within a narrow region.
 *
 * Input: frame-by-frame stats from sequential decode of [regionStart, regionEnd].
 * Logic:
 *   - Single spike (1-2 frames): Hard Cut → mark immediately
 *   - 3+ consecutive spikes: Camera pan / flash → skip (false positive)
 */
export function findExactCut(
	fineStats: FrameStats[],
	threshold = 0.75,
): SceneBoundary | null {
	const deltas: number[] = [];

	// Compute all pairwise deltas
	for (let i = 1; i < fineStats.length; i++) {
		deltas.push(
			histogramDistance(
				fineStats[i - 1].rgbHistogram,
				fineStats[i].rgbHistogram,
			),
		);
	}

	// Scan for spikes
	let i = 0;
	while (i < deltas.length) {
		if (deltas[i] > threshold) {
			// Count consecutive high-delta frames
			let clusterEnd = i;
			while (
				clusterEnd + 1 < deltas.length &&
				deltas[clusterEnd + 1] > threshold
			) {
				clusterEnd++;
			}

			const clusterLength = clusterEnd - i + 1;

			if (clusterLength <= 2) {
				// ✅ HARD CUT: Single spike → mark at the first frame of the new scene
				return {
					timestamp: fineStats[i + 1].timestamp,
					type: "hard_cut",
					confidence: deltas[i],
				};
			}
			// ❌ 3+ consecutive → Flash/Pan → skip
			i = clusterEnd + 1;
		} else {
			i++;
		}
	}

	return null;
}
