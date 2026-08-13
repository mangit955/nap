"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type RecognitionResult = {
  isFinal: boolean;
  0: { transcript: string } | undefined;
};

type RecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
};

type RecognitionErrorEvent = { error: string };

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type RecognitionConstructor = new () => Recognition;

type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
};

export type Dictation = {
  supported: boolean;
  listening: boolean;
  interim: string;
  error: string | undefined;
  toggle: () => void;
  stop: () => void;
};

/**
 * The browser's dictation service, kept separate from the composer's committed prompt.
 *
 * Recognition APIs are still prefixed in Safari and absent in many browsers, so capability is
 * discovered after mount and failure is a local, recoverable state rather than a page error.
 */
export function useDictation(onFinal: (text: string) => void): Dictation {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const recognition = useRef<Recognition | undefined>(undefined);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    const browser = window as SpeechWindow;
    setSupported(
      browser.SpeechRecognition !== undefined || browser.webkitSpeechRecognition !== undefined,
    );

    return () => recognition.current?.abort();
  }, []);

  const stop = useCallback(() => {
    recognition.current?.stop();
    setListening(false);
    setInterim("");
  }, []);

  const toggle = useCallback(() => {
    if (listening) {
      stop();
      return;
    }

    const browser = window as SpeechWindow;
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (Constructor === undefined) return;

    setError(undefined);
    setInterim("");

    const next = new Constructor();
    recognition.current = next;
    next.continuous = true;
    next.interimResults = true;
    next.onresult = (event) => {
      if (recognition.current !== next) return;
      let finalText = "";
      let interimText = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript.trim() ?? "";
        if (result?.isFinal) finalText += transcript;
        else interimText += transcript;
      }

      if (finalText !== "") onFinalRef.current(finalText);
      setInterim(interimText);
    };
    next.onerror = (event) => {
      if (recognition.current !== next) return;
      setListening(false);
      setInterim("");
      setError(
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "Microphone access was not granted."
          : "Dictation stopped. Try again.",
      );
    };
    next.onend = () => {
      if (recognition.current !== next) return;
      setListening(false);
      setInterim("");
    };

    try {
      next.start();
      setListening(true);
    } catch {
      setError("Dictation could not start. Try again.");
    }
  }, [listening, stop]);

  return { supported, listening, interim, error, toggle, stop };
}

/** Appends speech as words, never running it into the prompt the person already wrote. */
export function appendDictation(prompt: string, transcript: string): string {
  const spoken = transcript.trim();
  if (spoken === "") return prompt;
  return prompt === "" || /\s$/.test(prompt) ? `${prompt}${spoken}` : `${prompt} ${spoken}`;
}
