from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem, Preformatted
from reportlab.lib.styles import getSampleStyleSheet
ss = getSampleStyleSheet()
doc = SimpleDocTemplate("reportlab.pdf", pagesize=A4, title="ReportLab Test")
story = [Paragraph("Quarterly Summary", ss["Title"]), Paragraph("Introduction", ss["Heading1"]),
 Paragraph("This is <b>bold</b> and <i>italic</i> text with a <a href='https://example.org'>link</a>. " * 3, ss["Normal"]),
 Spacer(1, 12), Paragraph("Second paragraph with ligatures: office affluent. Price €5.", ss["Normal"]),
 Paragraph("Section Two", ss["Heading2"]),
 ListFlowable([ListItem(Paragraph("alpha", ss["Normal"])), ListItem(Paragraph("beta", ss["Normal"]))], bulletType="bullet"),
 Preformatted("def f(x):\n    return x * 2", ss["Code"])]
doc.build(story)
