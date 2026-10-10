import type { SVGProps } from "react";

export function InboxMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <rect x="1" y="1" width="38" height="38" rx="11" fill="currentColor" />
      <path
        d="M9 21.5h6.1l2.1 3h5.6l2.1-3H31v8H9v-8Z"
        fill="var(--inbox-mark-tray, #282333)"
        stroke="var(--inbox-mark-line, #D9D0F5)"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M12 17.5c2.1-2.5 4.1-2.5 6.2 0s4.1 2.5 6.2 0 4.1-2.5 6.2 0"
        stroke="var(--inbox-mark-wave, #C3AEFF)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M20.5 8.5v6m0 0-2.6-2.6m2.6 2.6 2.6-2.6" stroke="#F4F0FF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
