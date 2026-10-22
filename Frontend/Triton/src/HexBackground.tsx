import { useEffect, useRef } from "react";

export type HexMode = "off" | "grid" | "synth" | "media";
export type HexPalette = "mono" | "binary" | "color";

type HexBackgroundProps = {
  mode: HexMode;
  size: number;
  intensity: number;
  palette: HexPalette;
  media: File | string | null;
};

const UNIT_HEX = Array.from({ length: 6 }, (_, index) => {
  const angle = -Math.PI / 2 + index * Math.PI / 3;
  return { cos: Math.cos(angle), sin: Math.sin(angle) };
});

export default function HexBackground({ mode, size, intensity, palette, media }: HexBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;

    const sampleCanvas = document.createElement("canvas");
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    const synthCanvas = document.createElement("canvas");
    synthCanvas.width = 160;
    synthCanvas.height = 100;
    const sourceVideo = document.createElement("video");
    sourceVideo.loop = true;
    sourceVideo.muted = true;
    sourceVideo.playsInline = true;
    const sourceImage = new Image();
    if (!sampleContext) return;

    let width = 0;
    let height = 0;
    let cells: Array<{ col: number; row: number; x: number; y: number }> = [];
    let frame = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isVideo = Boolean(media && (typeof media === "string" || media.type.startsWith("video/")));
    const shouldAnimate = !reducedMotion && (mode === "synth" || (mode === "media" && isVideo));
    const mediaUrl = media ? (typeof media === "string" ? media : URL.createObjectURL(media)) : null;

    function rebuildGrid() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = Math.max(1, window.innerHeight - 48);
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      context!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const hexWidth = Math.sqrt(3) * size;
      const verticalSpacing = 1.5 * size;
      const cols = Math.ceil(width / hexWidth) + 2;
      const rows = Math.ceil(height / verticalSpacing) + 2;
      sampleCanvas.width = Math.max(1, cols);
      sampleCanvas.height = Math.max(1, rows);
      cells = [];

      for (let row = 0; row < rows; row += 1) {
        const y = row * verticalSpacing;
        const offset = row % 2 ? hexWidth * 0.5 : 0;
        for (let col = 0; col < cols; col += 1) {
          cells.push({ col, row, x: col * hexWidth + offset, y });
        }
      }
    }

    function drawSynth(time: number) {
      const synthContext = synthCanvas.getContext("2d");
      if (!synthContext) return;
      const w = synthCanvas.width;
      const h = synthCanvas.height;
      const cx = w * 0.5 + Math.sin(time * 0.45) * 14;
      const cy = h * 0.5 + Math.cos(time * 0.35) * 7;
      const planetRadius = Math.min(w, h) * 0.25;

      synthContext.fillStyle = "#000";
      synthContext.fillRect(0, 0, w, h);
      synthContext.save();
      synthContext.translate(cx, cy);
      synthContext.rotate(-0.38 + Math.sin(time * 0.25) * 0.07);

      synthContext.beginPath();
      synthContext.ellipse(0, 0, planetRadius * 2.25, planetRadius * 0.58, 0, Math.PI, Math.PI * 2);
      synthContext.strokeStyle = "#757575";
      synthContext.lineWidth = 4.5;
      synthContext.stroke();

      const gradient = synthContext.createRadialGradient(
        Math.cos(time * 0.85) * planetRadius * 0.45,
        -planetRadius * 0.25,
        planetRadius * 0.1,
        0,
        0,
        planetRadius,
      );
      gradient.addColorStop(0, "#fff");
      gradient.addColorStop(0.55, "#a8a8a8");
      gradient.addColorStop(0.85, "#383838");
      gradient.addColorStop(1, "#101010");
      synthContext.beginPath();
      synthContext.arc(0, 0, planetRadius, 0, Math.PI * 2);
      synthContext.fillStyle = gradient;
      synthContext.fill();

      synthContext.beginPath();
      synthContext.ellipse(0, 0, planetRadius * 2.25, planetRadius * 0.58, 0, 0, Math.PI);
      synthContext.strokeStyle = "#f2f2f2";
      synthContext.lineWidth = 5.5;
      synthContext.stroke();

      const orbitAngle = time * 1.8;
      if (Math.sin(orbitAngle) > -0.3) {
        synthContext.beginPath();
        synthContext.arc(
          Math.cos(orbitAngle) * planetRadius * 2.25,
          Math.sin(orbitAngle) * planetRadius * 0.58,
          4.5,
          0,
          Math.PI * 2,
        );
        synthContext.fillStyle = "#fff";
        synthContext.fill();
      }
      synthContext.restore();
    }

    function drawHexagon(x: number, y: number, radius: number) {
      context!.beginPath();
      UNIT_HEX.forEach((point, index) => {
        const px = x + radius * point.cos;
        const py = y + radius * point.sin;
        if (index === 0) context!.moveTo(px, py);
        else context!.lineTo(px, py);
      });
      context!.closePath();
      context!.fill();
    }

    function sampleMedia(source: CanvasImageSource, mediaWidth: number, mediaHeight: number) {
      const gridWidth = sampleCanvas.width;
      const gridHeight = sampleCanvas.height;
      if (!mediaWidth || !mediaHeight) return null;

      const gridAspect = gridWidth / gridHeight;
      const mediaAspect = mediaWidth / mediaHeight;
      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = mediaWidth;
      let sourceHeight = mediaHeight;
      if (mediaAspect > gridAspect) {
        sourceWidth = mediaHeight * gridAspect;
        sourceX = (mediaWidth - sourceWidth) * 0.5;
      } else {
        sourceHeight = mediaWidth / gridAspect;
        sourceY = (mediaHeight - sourceHeight) * 0.5;
      }

      sampleContext!.clearRect(0, 0, gridWidth, gridHeight);
      sampleContext!.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, gridWidth, gridHeight);
      return sampleContext!.getImageData(0, 0, gridWidth, gridHeight).data;
    }

    function render(now: number) {
      const time = reducedMotion ? 0 : now * 0.001;
      context!.fillStyle = "#181818";
      context!.fillRect(0, 0, width, height);

      if (mode !== "off") {
        let pixelData: Uint8ClampedArray | null = null;
        if (mode === "synth") {
          drawSynth(time);
          sampleContext!.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
          sampleContext!.drawImage(synthCanvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
          pixelData = sampleContext!.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
        } else if (mode === "media" && media) {
          pixelData = isVideo
            ? sampleMedia(sourceVideo, sourceVideo.videoWidth, sourceVideo.videoHeight)
            : sampleMedia(sourceImage, sourceImage.naturalWidth, sourceImage.naturalHeight);
        }

        const innerRadius = Math.max(0.75, size - 1.25);
        for (const cell of cells) {
          let red = 31;
          let green = 31;
          let blue = 31;
          if (pixelData) {
            const pixel = (cell.row * sampleCanvas.width + cell.col) * 4;
            const sourceRed = pixelData[pixel];
            const sourceGreen = pixelData[pixel + 1];
            const sourceBlue = pixelData[pixel + 2];
            const luminance = (0.299 * sourceRed + 0.587 * sourceGreen + 0.114 * sourceBlue) / 255;
            const quantized = Math.round(luminance * 7) / 7;
            const finalLuminance = Math.min(1, quantized * intensity / 100);

            if (palette === "mono") {
              red = green = blue = Math.round(30 + finalLuminance * 175);
            } else if (palette === "binary") {
              red = green = blue = finalLuminance > 0.24 ? 58 : 29;
            } else {
              red = Math.min(255, Math.round(28 + sourceRed * intensity / 100));
              green = Math.min(255, Math.round(28 + sourceGreen * intensity / 100));
              blue = Math.min(255, Math.round(28 + sourceBlue * intensity / 100));
            }
          }
          context!.fillStyle = `rgb(${red}, ${green}, ${blue})`;
          drawHexagon(cell.x, cell.y, innerRadius);
        }
      }

      if (shouldAnimate) frame = window.requestAnimationFrame(render);
    }

    function renderLoadedMedia() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(render);
    }

    if (mode === "media" && mediaUrl && media) {
      if (isVideo) {
        sourceVideo.src = mediaUrl;
        sourceVideo.onloadeddata = renderLoadedMedia;
        if (!reducedMotion) void sourceVideo.play().catch(() => undefined);
      } else {
        sourceImage.onload = renderLoadedMedia;
        sourceImage.src = mediaUrl;
      }
    }

    rebuildGrid();
    function handleResize() {
      rebuildGrid();
      if (!shouldAnimate) renderLoadedMedia();
    }
    window.addEventListener("resize", handleResize);
    frame = window.requestAnimationFrame(render);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
      sourceVideo.pause();
      sourceVideo.onloadeddata = null;
      sourceVideo.removeAttribute("src");
      sourceImage.onload = null;
      sourceImage.removeAttribute("src");
      if (mediaUrl && media && typeof media !== "string") URL.revokeObjectURL(mediaUrl);
    };
  }, [intensity, media, mode, palette, size]);

  return <canvas ref={canvasRef} className="hex-background" aria-hidden="true" />;
}
