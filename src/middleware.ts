import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

// 認証ミドルウェア: セッション更新 & 未認証リダイレクト
export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // JWT検証（getSession ではなく getUser を使用）
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // 未認証ユーザーを /login にリダイレクト（/api/auth は除外）
  if (
    !user &&
    !request.nextUrl.pathname.startsWith("/login") &&
    !request.nextUrl.pathname.startsWith("/api/auth")
  ) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    return NextResponse.redirect(url)
  }

  // ログインできるのは許可リスト（allowed_emails）にあるアドレスだけ。
  //
  // これが無いと、Googleアカウントを持っている人なら誰でもログインでき、
  // 取引先名・金額・スタッフの氏名と立替額が見えてしまう。
  //
  // RLSで「自分のアドレスの行」しか読めないため、1件でも返れば許可されている。
  // migration 047 未適用の環境ではテーブルが無く、従来どおり全員が使える
  // （適用前に全員が締め出されるのを防ぐため）。
  if (user && !request.nextUrl.pathname.startsWith("/denied")) {
    const email = user.email?.toLowerCase() ?? ""
    // allowed_emails は型定義の再生成前のため、型チェックを通すために any 経由で呼ぶ
    const { data: allowed, error: allowedError } = await (
      supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => {
              maybeSingle: () => Promise<{
                data: { id: string } | null
                error: { code?: string; message?: string } | null
              }>
            }
          }
        }
      }
    )
      .from("allowed_emails")
      .select("id")
      .eq("email", email)
      .maybeSingle()

    const tableMissing =
      allowedError?.code === "42P01" || /allowed_emails/.test(allowedError?.message || "")
    if (!tableMissing && !allowed) {
      const url = request.nextUrl.clone()
      url.pathname = "/denied"
      url.search = ""
      return NextResponse.redirect(url)
    }
  }

  // 認証済みユーザーが /login にアクセスした場合はトップへ
  if (user && request.nextUrl.pathname.startsWith("/login")) {
    const url = request.nextUrl.clone()
    url.pathname = "/"
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // 静的ファイル・API・Next.js内部パスをスキップ
    "/((?!_next/static|_next/image|favicon.ico|api|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
