import { useCallback, useEffect, useRef, useState } from "react";

type TritonMascotProps = {
  isListening: boolean;
  isThinking: boolean;
  isTyping: boolean;
  isActive: boolean;
  eyeWidth: number;
  eyeLength: number;
};

function roundedHexPath() {
  const points = [-Math.PI / 2, -Math.PI / 6, Math.PI / 6, Math.PI / 2, (5 * Math.PI) / 6, (7 * Math.PI) / 6]
    .map((angle) => ({ x: 100 + 90 * Math.cos(angle), y: 100 + 90 * Math.sin(angle) }));
  const trim = 18 / Math.sqrt(3);
  return points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const inLength = Math.hypot(previous.x - point.x, previous.y - point.y);
    const outLength = Math.hypot(next.x - point.x, next.y - point.y);
    const startX = point.x + ((previous.x - point.x) / inLength) * trim;
    const startY = point.y + ((previous.y - point.y) / inLength) * trim;
    const endX = point.x + ((next.x - point.x) / outLength) * trim;
    const endY = point.y + ((next.y - point.y) / outLength) * trim;
    return `${index === 0 ? "M" : "L"} ${startX.toFixed(2)} ${startY.toFixed(2)} A 18 18 0 0 1 ${endX.toFixed(2)} ${endY.toFixed(2)}`;
  }).join(" ") + " Z";
}

const IDLE_GAZE_DIRECTIONS = [
  { x: -14, y: -8 },
  { x: 0, y: -10 },
  { x: 14, y: -8 },
  { x: -16, y: 0 },
  { x: 16, y: 0 },
  { x: -14, y: 9 },
  { x: 0, y: 10 },
  { x: 14, y: 9 },
  { x: 0, y: 0 },
];

export default function TritonMascot({ isListening, isThinking, isTyping, isActive, eyeWidth, eyeLength }: TritonMascotProps) {
  const [isBlinking, setIsBlinking] = useState(false);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const mascotRef = useRef<HTMLSpanElement>(null);
  const cursorGazeRef = useRef<{ x: number; y: number } | null>(null);
  const currentGazeRef = useRef({ x: 0, y: 0 });
  const targetGazeRef = useRef({ x: 0, y: 0 });
  const gazeFrameRef = useRef<number | null>(null);
  const lastGazeFrameTimeRef = useRef<number | null>(null);
  const animateGazeRef = useRef<(timestamp: number) => void>(() => {});

  animateGazeRef.current = (timestamp) => {
    gazeFrameRef.current = null;
    const previousTime = lastGazeFrameTimeRef.current;
    const deltaTime = previousTime === null ? 16.67 : Math.min(50, Math.max(0, timestamp - previousTime));
    lastGazeFrameTimeRef.current = timestamp;

    const current = currentGazeRef.current;
    const target = targetGazeRef.current;
    const follow = 1 - Math.exp(-deltaTime / 24);
    const next = {
      x: current.x + (target.x - current.x) * follow,
      y: current.y + (target.y - current.y) * follow,
    };
    const remaining = Math.hypot(target.x - next.x, target.y - next.y);

    if (remaining < 0.08) {
      currentGazeRef.current = target;
      lastGazeFrameTimeRef.current = null;
      setGaze(target);
      return;
    }

    currentGazeRef.current = next;
    setGaze(next);
    gazeFrameRef.current = window.requestAnimationFrame((nextTimestamp) => animateGazeRef.current(nextTimestamp));
  };

  const scheduleGazeAnimation = useCallback(() => {
    if (gazeFrameRef.current !== null) return;
    lastGazeFrameTimeRef.current = null;
    gazeFrameRef.current = window.requestAnimationFrame((timestamp) => animateGazeRef.current(timestamp));
  }, []);

  useEffect(() => {
    if (!isActive || isListening) return;

    function followPointer(event: PointerEvent) {
      if (event.pointerType !== "mouse") return;
      const bounds = mascotRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const offsetX = event.clientX - (bounds.left + bounds.width / 2);
      const offsetY = event.clientY - (bounds.top + bounds.height / 2);
      const distance = Math.hypot(offsetX, offsetY);
      const reach = Math.min(Math.hypot(window.innerWidth, window.innerHeight) * 0.42, 520);
      if (distance > reach) {
        cursorGazeRef.current = null;
        targetGazeRef.current = { x: 0, y: 0 };
        scheduleGazeAnimation();
        return;
      }
      const nearRadius = 20;
      const smoothStep = (value: number) => {
        const amount = Math.max(0, Math.min(1, value));
        return amount * amount * (3 - 2 * amount);
      };
      const proximity = smoothStep(distance / nearRadius);
      const fadeRange = Math.max(1, reach - nearRadius);
      const distanceFade = 1 - smoothStep((distance - nearRadius) / fadeRange);
      const strength = proximity * (0.15 + 0.85 * distanceFade);
      const nextGaze = {
        x: distance ? (offsetX / distance) * 27 * strength : 0,
        y: distance ? (offsetY / distance) * 38 * strength : 0,
      };
      cursorGazeRef.current = nextGaze;
      targetGazeRef.current = nextGaze;
      scheduleGazeAnimation();
    }

    window.addEventListener("pointermove", followPointer, { passive: true });
    return () => {
      window.removeEventListener("pointermove", followPointer);
      if (gazeFrameRef.current !== null) window.cancelAnimationFrame(gazeFrameRef.current);
      gazeFrameRef.current = null;
      lastGazeFrameTimeRef.current = null;
    };
  }, [isActive, isListening, scheduleGazeAnimation]);

  useEffect(() => {
    if (!isActive || isListening || isThinking || isTyping) return;

    let idleGazeTimer = 0;
    let lastDirection = -1;
    let cancelled = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function scheduleIdleGaze() {
      if (cancelled || reducedMotion) return;
      idleGazeTimer = window.setTimeout(() => {
        if (!cursorGazeRef.current) {
          const directionCount = IDLE_GAZE_DIRECTIONS.length;
          const randomDirection = Math.floor(Math.random() * directionCount);
          const direction = randomDirection === lastDirection
            ? (randomDirection + 1 + Math.floor(Math.random() * (directionCount - 1))) % directionCount
            : randomDirection;
          lastDirection = direction;
          targetGazeRef.current = IDLE_GAZE_DIRECTIONS[direction];
          scheduleGazeAnimation();
        }
        scheduleIdleGaze();
      }, 1500 + Math.random() * 1900);
    }

    scheduleIdleGaze();
    return () => {
      cancelled = true;
      window.clearTimeout(idleGazeTimer);
    };
  }, [isActive, isListening, isThinking, isTyping, scheduleGazeAnimation]);

  useEffect(() => {
    if (!isActive) {
      cursorGazeRef.current = null;
      targetGazeRef.current = { x: 0, y: 0 };
      currentGazeRef.current = { x: 0, y: 0 };
      lastGazeFrameTimeRef.current = null;
      if (gazeFrameRef.current !== null) window.cancelAnimationFrame(gazeFrameRef.current);
      gazeFrameRef.current = null;
      setGaze({ x: 0, y: 0 });
      return;
    }
    if (isListening) {
      cursorGazeRef.current = null;
      targetGazeRef.current = { x: 0, y: -2 };
    } else {
      const pointerGaze = cursorGazeRef.current;
      if (pointerGaze) targetGazeRef.current = pointerGaze;
      else if (isThinking) targetGazeRef.current = { x: 0, y: -2 };
      else targetGazeRef.current = { x: 0, y: isTyping ? 8 : 0 };
    }
    scheduleGazeAnimation();
  }, [isActive, isListening, isThinking, isTyping, scheduleGazeAnimation]);

  useEffect(() => {
    if (!isActive || isListening || isThinking || isTyping) {
      setIsBlinking(false);
      return;
    }

    const blinkTimers = new Set<number>();
    let cancelled = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function setTimer(callback: () => void, delay: number) {
      let timer = 0;
      timer = window.setTimeout(() => {
        blinkTimers.delete(timer);
        if (cancelled) return;
        callback();
      }, delay);
      blinkTimers.add(timer);
    }

    function scheduleBlink() {
      if (cancelled || reducedMotion) return;
      setTimer(() => {
        setIsBlinking(true);
        setTimer(() => {
          setIsBlinking(false);
          if (Math.random() < 0.4) {
            setTimer(() => {
              setIsBlinking(true);
              setTimer(() => {
                setIsBlinking(false);
                scheduleBlink();
              }, 130);
            }, 110);
          } else {
            scheduleBlink();
          }
        }, 130);
      }, 1800 + Math.random() * 1900);
    }

    scheduleBlink();
    return () => {
      cancelled = true;
      blinkTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [isActive, isListening, isThinking, isTyping]);

  return (
    <span ref={mascotRef} className={`mascot-shell ${isListening ? "listening" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 200 200" className="mascot-svg">
        <path d={roundedHexPath()} fill="#252525" stroke="#363636" strokeWidth="2" />
        <g className={`mascot-eyes ${isThinking && !cursorGazeRef.current ? "thinking" : ""}`} style={{ transform: `translate(${gaze.x}px, ${gaze.y}px)` }}>
          <g className={`mascot-eye-wrapper ${isBlinking ? "blinking" : ""}`} style={{ transformOrigin: "79px 100px" }}>
            <rect x={79 - eyeWidth / 2} y={100 - eyeLength / 2} width={eyeWidth} height={eyeLength} rx={eyeWidth / 2} fill="#fff" />
          </g>
          <g className={`mascot-eye-wrapper ${isBlinking ? "blinking" : ""}`} style={{ transformOrigin: "121px 100px" }}>
            <rect x={121 - eyeWidth / 2} y={100 - eyeLength / 2} width={eyeWidth} height={eyeLength} rx={eyeWidth / 2} fill="#fff" />
          </g>
        </g>
      </svg>
    </span>
  );
}
