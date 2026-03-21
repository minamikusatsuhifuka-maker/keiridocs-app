import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { DocumentStatus } from "@/types"

const statusConfig: Record<DocumentStatus, { label: string; className: string }> = {
  "未処理": {
    label: "未処理",
    className: "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-100",
  },
  "処理済み": {
    label: "処理済み",
    className: "bg-[#F0E0C8] text-[#8B5E2F] border-[#E0CEB8] hover:bg-[#F0E0C8]",
  },
  "アーカイブ": {
    label: "アーカイブ",
    className: "bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-100",
  },
}

interface StatusBadgeProps {
  status: DocumentStatus
  className?: string
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig["未処理"]

  return (
    <Badge
      variant="outline"
      className={cn(config.className, className)}
    >
      {config.label}
    </Badge>
  )
}
