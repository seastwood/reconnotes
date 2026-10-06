#!/usr/bin/env ruby
# Takes the Push Notifications capability off the app again – needed when
# signing with a free (Personal Team) Apple account, which can't use push.
#
# Run on the Mac:  npm run ios:disable-push -w @reconnotes/web
# (By hand instead: Xcode › App target › Signing & Capabilities › Push Notifications › ✕.)
begin
  require 'xcodeproj'
rescue LoadError
  abort "The xcodeproj Ruby gem is missing. Install it with:\n  gem install --user-install xcodeproj\n(or sudo gem install xcodeproj), then run this again."
end

IOS = File.expand_path('../App', __dir__)
project = Xcodeproj::Project.open(File.join(IOS, 'App.xcodeproj'))
app = project.targets.find { |t| t.name == 'App' } or abort 'No "App" target in the Xcode project'
rel = app.build_configurations.map { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] }.compact.first
if rel && File.exist?(path = File.join(IOS, rel))
  plist = Xcodeproj::Plist.read_from_path(path) || {}
  plist.delete('aps-environment')
  Xcodeproj::Plist.write_to_path(plist, path)
end
caps = project.root_object.attributes.dig('TargetAttributes', app.uuid, 'SystemCapabilities')
caps&.delete('com.apple.Push')
project.save
puts 'Push notifications are off for the App target. Build and run from Xcode as usual.'
