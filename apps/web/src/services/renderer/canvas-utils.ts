export function createOffscreenCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): OffscreenCanvas | HTMLCanvasElement {
	try {
		return new OffscreenCanvas(width, height);
	} catch {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}
}

class CanvasPool {
	private pool: Map<string, (OffscreenCanvas | HTMLCanvasElement)[]> = new Map();

	private getKey(width: number, height: number) {
		return `${width}x${height}`;
	}

	get(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
		const key = this.getKey(width, height);
		const list = this.pool.get(key);
		if (list && list.length > 0) {
			return list.pop()!;
		}
		return createOffscreenCanvas({ width, height });
	}

	release(canvas: OffscreenCanvas | HTMLCanvasElement) {
		const key = this.getKey(canvas.width, canvas.height);
		if (!this.pool.has(key)) {
			this.pool.set(key, []);
		}
		this.pool.get(key)!.push(canvas);
	}
}

export const canvasPool = new CanvasPool();
