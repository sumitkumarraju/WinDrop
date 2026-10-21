# Shows a Windows notification. The toast XML and app id come in through environment variables
# (WD_XML, WD_APPID) so file names never need shell escaping.
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($env:WD_XML)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:WD_APPID).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
