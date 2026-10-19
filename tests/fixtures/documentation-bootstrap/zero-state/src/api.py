from .auth import authorised


def handle(token: str) -> dict[str, bool]:
    return {"authorised": authorised(token)}
