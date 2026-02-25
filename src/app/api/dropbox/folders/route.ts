import { NextResponse } from "next/server"

// Dropboxフォルダ作成・一覧 API
export async function GET() {
  return NextResponse.json({ data: [] })
}

export async function POST() {
  return NextResponse.json({ data: null })
}
