import { AppPreview } from "../../../landing/app-preview.tsx";
import "../../../landing/product-story.css";

export const metadata = { title: "Ledger example app", robots: { index: false, follow: false } };

export default function LedgerDemoPage() {
  return (
    <div className="ps-generated-app">
      <AppPreview />
    </div>
  );
}
