/** Material Symbols glyph. The icon set used by the supplied design. */
export function Icon({
  name,
  size = 24,
  filled = false,
  className = '',
  weight = 400,
}: {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
  weight?: number;
}) {
  return (
    <span
      className={`icon ${className}`}
      aria-hidden="true"
      style={{
        fontSize: size,
        fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' ${weight}, 'GRAD' 0, 'opsz' ${size}`,
      }}
    >
      {name}
    </span>
  );
}
