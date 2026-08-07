import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Speech in and out, using what Safari actually provides.
 *
 * `SpeechRecognition` is still vendor-prefixed on Safari and is not implemented at all in some
 * browsers, so the hook reports whether it is available rather than assuming. The UI degrades to
 * typing, which is why the composer keeps a text field even though the product is voice-forward:
 * a mic that silently does nothing is worse than no mic.
 *
 * Speech recognition on iOS may route audio through Apple's servers. That is worth knowing for a
 * product about someone's finances, and it is the reason spoken input is opt-in per utterance —
 * the microphone is never left listening.
 */

interface SpeechRecognitionAlternative {
  readonly transcript: string;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export interface Voice {
  readonly canListen: boolean;
  readonly canSpeak: boolean;
  readonly listening: boolean;
  /** Live transcript while listening, so the user can see they are being heard. */
  readonly partial: string;
  readonly error: string | null;
  startListening(): void;
  stopListening(): void;
  speak(text: string): void;
  cancelSpeech(): void;
}

export function useVoice(onUtterance: (text: string) => void): Voice {
  const Recognition = useMemo(recognitionConstructor, []);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Held in a ref so restarting recognition does not need a new callback identity.
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  useEffect(() => {
    if (Recognition === null) return;

    const recognition = new Recognition();
    // en-NG so Nigerian place and merchant names stand a better chance than under en-US.
    recognition.lang = 'en-NG';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? '';

        if (result?.isFinal === true) final += text;
        else interim += text;
      }

      if (interim !== '') setPartial(interim);

      if (final.trim() !== '') {
        setPartial('');
        onUtteranceRef.current(final.trim());
      }
    };

    recognition.onerror = (event) => {
      const code = (event as Event & { error?: string }).error ?? 'unknown';

      // `no-speech` and `aborted` are ordinary outcomes of tapping the mic and saying nothing.
      // Surfacing them as errors would train the user to distrust a working feature.
      setError(
        code === 'no-speech' || code === 'aborted'
          ? null
          : code === 'not-allowed'
            ? 'Microphone access was denied'
            : `Could not listen (${code})`,
      );
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
      setPartial('');
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
      recognitionRef.current = null;
    };
  }, [Recognition]);

  const startListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition === null) return;

    setError(null);
    setPartial('');

    // Speaking over the assistant is natural; leaving it talking while listening is not.
    if (canSpeak) window.speechSynthesis.cancel();

    try {
      recognition.start();
      setListening(true);
    } catch {
      // Thrown when start() is called while already running. Not worth surfacing.
    }
  }, [canSpeak]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!canSpeak || text.trim() === '') return;

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-NG';
      utterance.rate = 1.02;

      window.speechSynthesis.speak(utterance);
    },
    [canSpeak],
  );

  const cancelSpeech = useCallback(() => {
    if (canSpeak) window.speechSynthesis.cancel();
  }, [canSpeak]);

  return {
    canListen: Recognition !== null,
    canSpeak,
    listening,
    partial,
    error,
    startListening,
    stopListening,
    speak,
    cancelSpeech,
  };
}
