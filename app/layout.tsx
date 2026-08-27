import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sprite Forge Studio",
  description: "Human-Directed Sprite Stabilization Pipeline & Character Studio for DGX Spark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          background: "#0d1117",
          color: "#c9d1d9",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
