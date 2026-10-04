/** The experience bar, standing in for overall progress. */
export function XpBar({ value, level }: { value: number; level: number }) {
  const outline = "#000";
  return (
    <div className="relative pt-[calc(var(--s)*7)]">
      <span
        className="absolute inset-x-0 top-0 text-center font-pixel text-[17px] leading-none text-xp"
        style={{
          textShadow: `var(--s) 0 0 ${outline}, calc(var(--s) * -1) 0 0 ${outline}, 0 var(--s) 0 ${outline}, 0 calc(var(--s) * -1) 0 ${outline}`,
        }}
        aria-hidden
      >
        {level}
      </span>
      <div
        className="h-[calc(var(--s)*5)] border-[length:var(--s)] border-black bg-[#20301a]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-label="Download progress"
      >
        <div
          className="h-full bg-xp shadow-[inset_0_var(--s)_0_#c6ff8f] transition-[width] duration-200"
          style={{ width: `${value * 100}%` }}
        />
      </div>
    </div>
  );
}
