// 웹에서 기계 카드 선택 시 POST → UE MachineActor가 GET으로 폴링해 발광 여부 결정
let selectedId: string | null = null;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  selectedId = body?.id ?? null;
  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ id: selectedId });
}
