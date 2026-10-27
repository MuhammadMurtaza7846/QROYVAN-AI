from app.rag import split_text

def test_split_text_empty():
    assert split_text("   ") == []

def test_split_text_covers_content():
    source = "alpha beta gamma " * 180
    chunks = split_text(source, size=100, overlap=10)
    assert len(chunks) > 1
    assert all(chunks)
    assert "alpha" in chunks[0]
