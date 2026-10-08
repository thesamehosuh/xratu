/**
 * Provider registration, imported for its side effect by the extension host.
 *
 * Kept apart from the host so the registry stays a pure data structure and the
 * set of shipped providers is visible in one file: an OAuth feature that
 * cannot be turned off at runtime should at least be greppable and obvious.
 */
import { registerOAuthProvider } from '../providerAuthRegistry';
import { openAiCodexHandler } from './openaiCodex';

registerOAuthProvider(openAiCodexHandler);