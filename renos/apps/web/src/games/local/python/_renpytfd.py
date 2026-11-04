# RenOS: Ersatz fuer Ren'Pys Datei-Dialoge (tinyfiledialogs, "_renpytfd"), die es in der Web-Laufzeit nicht
# gibt. "Oeffnen" zeigt die Dateiauswahl von RenOS, "Speichern unter" legt die Datei in RenOS ab
# (Files -> Downloads). Gleiche Aufrufe wie das Original.
import _renos_host


def openFileDialog(title=u"", default_path=u"", filter_patterns=None, filter_description=None, multiple_selects=False, *args, **kwargs):
    multiple = bool(multiple_selects or kwargs.get("allow_multiple_selects"))
    paths = _renos_host.open_files(title, filter_patterns, multiple)
    if not paths:
        return None
    if multiple:
        return u"|".join(paths)
    return paths[0]


def saveFileDialog(title=u"", default_path=u"", filter_patterns=None, filter_description=None, *args, **kwargs):
    return _renos_host.save_target(default_path)


def selectFolderDialog(title=u"", default_path=u"", *args, **kwargs):
    return None


def messageBox(title=u"", message=u"", dialog_type=u"ok", icon_type=u"info", default_button=1, *args, **kwargs):
    _renos_host._notify(u"%s: %s" % (title, message) if title else message)
    return 1


def notifyPopup(title=u"", message=u"", icon_type=u"info", *args, **kwargs):
    _renos_host._notify(u"%s: %s" % (title, message) if title else message)
    return 1


def inputBox(*args, **kwargs):
    return None


def colorChooser(*args, **kwargs):
    return None


def beep(*args, **kwargs):
    return None
