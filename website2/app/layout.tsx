import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Clippy — A tiny teammate for Claude Code + Codex";
const description =
  "A local macOS buddy that watches your coding-agent sessions and lets you approve, answer, and review without hunting through terminal tabs.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  return {
    title,
    description,
    icons: {
      icon: `${basePath}/buddies/clip-idle.gif`,
      shortcut: `${basePath}/buddies/clip-idle.gif`,
    },
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: `${origin}${basePath}/og.png`, width: 1200, height: 630, alt: "Your coding agents have a tiny teammate." }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}${basePath}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
