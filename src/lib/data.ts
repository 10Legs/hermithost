// Mock site data has moved to api/src/data/mock.ts.
// This file retains shared utility helpers only.

export function formatRelativeTime(isoString: string): string {
	const date = new Date(isoString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return 'just now';
	if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
	if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
	return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}

export function formatDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	if (m === 0) return `${s}s`;
	return `${m}m ${s}s`;
}
