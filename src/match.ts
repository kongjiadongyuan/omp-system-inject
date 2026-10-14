// Pure model-spec matching.
/** Exact id first (ids may contain "/"); only if none, fall back to "provider/id". */
export function matchOriginals<M extends { id: string; provider: string }>(models: M[], spec: string): M[] {
	const exact = models.filter(m => m.id === spec);
	return exact.length ? exact : models.filter(m => `${m.provider}/${m.id}` === spec);
}

