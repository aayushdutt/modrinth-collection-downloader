import type { ButtonHTMLAttributes } from "react";

/** An inline action that reads as part of a sentence. */
export function TextButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`underline underline-offset-2 hover:text-black ${className}`} {...props} />;
}
