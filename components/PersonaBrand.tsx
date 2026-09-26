import Image from "next/image";
import Link from "next/link";

export default function PersonaBrand({
  persona,
  context,
  href = "/",
  compact = false,
}: {
  persona: "sweetie" | "sour";
  context: string;
  href?: string;
  compact?: boolean;
}) {
  const sour = persona === "sour";

  return (
    <Link
      href={href}
      className={`persona-brand ${sour ? "persona-brand-sour" : ""} ${
        compact ? "persona-brand-compact" : ""
      }`}
    >
      <Image
        src={
          sour
            ? "/assets/sour/sour.png"
            : "/assets/sweetie/sweetie.png"
        }
        alt=""
        width={compact ? 38 : 44}
        height={compact ? 38 : 44}
        className="persona-avatar"
        priority
      />
      <span>
        <strong>{sour ? "Sour" : "Sweet Spot"}</strong>
        <small>{context}</small>
      </span>
    </Link>
  );
}
