from .auth import authorised


def handle(token: str) -> bool:
    return authorised(token)
