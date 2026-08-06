// memory-lite: conservative suspicious-secret checks.
// Pattern checks are not complete DLP — v1 rejects obvious patterns and warns.

const SUSPICIOUS_PATTERNS = [
	// API keys (common formats)
	/sk-[a-zA-Z0-9]{20,}/i,           // OpenAI-style
	/ak_[a-zA-Z0-9]{20,}/i,           // Anthropic-style
	/api[_-]?key\s*[:=]\s*["\s]?[a-zA-Z0-9]{20,}/i,
	// Bearer tokens
	/bearer\s+[a-zA-Z0-9._-]{20,}/i,
	// Private keys
	/-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/i,
	// Password assignments
	/password\s*[:=]\s*["\s]?[^\s"']{4,}/i,
	// AWS keys
	/AKIA[0-9A-Z]{16}/,
	// GitHub tokens
	/gh[pousr]_[a-zA-Z0-9]{36}/i,
	// Generic long hex/base64 secrets
	/secret\s*[:=]\s*["\s]?[a-zA-Z0-9]{32,}/i,
];

export function isSuspiciousSecret(text: string): boolean {
	for (const pattern of SUSPICIOUS_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	return false;
}

export function safeErrorMessage(operation: string): string {
	// Never echo the rejected text in error messages.
	return `memory-lite: ${operation} rejected — input appears to contain credentials or secrets. Please review and remove sensitive data before adding.`;
}
