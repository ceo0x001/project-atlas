import { Module } from '@nestjs/common';

/**
 * Voice — streaming STT and TTS behind vendor-agnostic ports.
 *
 * Providers are adapters because the Nigerian-accent/Pidgin bake-off (risk R3) is
 * unresolved: Deepgram and Spitch both get an implementation, and the eval set
 * decides. Committing to a vendor before measuring would be guessing.
 *
 * Implementations land in M3.
 */
@Module({})
export class VoiceModule {}
