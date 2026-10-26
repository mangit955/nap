import { BookingPreview } from "../../../landing/booking-preview.tsx";

export const metadata = {
  title: "Highland stays example app",
  robots: { index: false, follow: false },
};

export default function BookingDemoPage() {
  return <BookingPreview />;
}
